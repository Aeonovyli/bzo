/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// polls.cjs - upstream's VotingArbiter (src/bzfs/VotingArbiter.cxx) and the
// yes/no VotingBooth it keeps: one poll at a time, who may vote on it, the
// count, and its clock. Times are seconds, as upstream's options give them;
// `now` is milliseconds, injected so a test can run the clock.

// CmdLineOptions.h:83. `-poll` sets each; its usage text says a veto time of
// 20, but the code starts it at 2.
const POLL_DEFAULTS = Object.freeze({
  voteTime: 60,
  vetoTime: 2,
  votesRequired: 2,
  votePercentage: 50.1,
  voteRepeatTime: 300,
});

class VotingArbiter {
  constructor(options = {}, now = () => Date.now()) {
    const settings = { ...POLL_DEFAULTS, ...options };
    this.voteTime = settings.voteTime;
    this.vetoTime = settings.vetoTime;
    this.votesRequired = settings.votesRequired;
    this.votePercentage = settings.votePercentage;
    this.voteRepeatTime = settings.voteRepeatTime;
    this.now = now;
    this.maxVotes = 0;
    // Callsign and time of each poll asked for, oldest first (`_pollers`).
    this.pollers = [];
    this.forgetPoll();
  }

  elapsed() {
    return (this.now() - this.startTime) / 1000;
  }

  knowsPoll() {
    return this.booth !== null;
  }

  isPollOpen() {
    return this.knowsPoll() && this.elapsed() < this.voteTime;
  }

  isPollClosed() {
    return this.knowsPoll() && this.elapsed() >= this.voteTime;
  }

  // Closed, and past the time an operator had to veto it.
  isPollExpired() {
    return this.knowsPoll() && this.elapsed() > this.voteTime + this.vetoTime;
  }

  forgetPoll() {
    this.booth = null;
    this.startTime = 0;
    this.target = 'nobody';
    this.action = '';
    this.organizer = null;
    this.targetAddress = null;
    this.suffraged = [];
    return true;
  }

  updatePollers() {
    const now = this.now();
    while (this.pollers.length && (now - this.pollers[0].lastRequest) / 1000 > this.voteRepeatTime) {
      this.pollers.shift();
    }
  }

  isPollerWaiting(name) {
    const lower = name.toLowerCase();
    return this.pollers.some((poller) => poller.name.toLowerCase() === lower);
  }

  // One poll at a time, and each callsign once every `voteRepeatTime`.
  poll(target, requester, action, organizer = null) {
    if (this.isPollOpen()) return false;
    this.updatePollers();
    if (this.isPollerWaiting(requester)) return false;
    this.pollers.push({ name: requester, lastRequest: this.now() });
    this.booth = new Map();
    this.target = target;
    this.action = action;
    this.organizer = organizer;
    this.startTime = this.now();
    return true;
  }

  // The address goes with the poll, so the ban lands on it even if the
  // victim has left or changed name by then (`_polleeIP`).
  pollToBan(victim, requester, organizer, address) {
    const started = this.poll(victim, requester, 'ban', organizer);
    if (started) this.targetAddress = address;
    return started;
  }

  pollToKick(victim, requester, organizer) {
    return this.poll(victim, requester, 'kick', organizer);
  }

  pollToKill(victim, requester, organizer) {
    return this.poll(victim, requester, 'kill', organizer);
  }

  pollToSet(setting, requester, organizer) {
    return this.poll(setting, requester, 'set', organizer);
  }

  // Upstream names this one's action `reset` and its target `flags`, so its
  // announcements read "A poll to reset flags".
  pollToResetFlags(requester, organizer) {
    return this.poll('flags', requester, 'reset', organizer);
  }

  closePoll() {
    if (!this.isPollClosed()) this.startTime = this.now() - (this.voteTime * 1000);
    return true;
  }

  setAvailableVoters(count) {
    this.maxVotes = count;
  }

  grantSuffrage(name) {
    const lower = name.toLowerCase();
    if (!this.suffraged.some((voter) => voter.toLowerCase() === lower)) this.suffraged.unshift(name);
  }

  hasSuffrage(name) {
    if (!this.isPollOpen()) return false;
    const lower = name.toLowerCase();
    if (!this.suffraged.some((voter) => voter.toLowerCase() === lower)) return false;
    if (this.booth.has(lower)) return false;
    return this.booth.size < this.maxVotes;
  }

  hasVoted(name) {
    return Boolean(this.booth?.has(name.toLowerCase()));
  }

  vote(name, answer) {
    if (!this.knowsPoll() || this.isPollClosed()) return false;
    if (!this.hasSuffrage(name)) return false;
    this.booth.set(name.toLowerCase(), answer);
    return true;
  }

  voteYes(name) {
    return this.vote(name, 'yes');
  }

  voteNo(name) {
    return this.vote(name, 'no');
  }

  // A voter who leaves takes the vote with them (bzfs.cxx:2920).
  retractVote(name) {
    return Boolean(this.booth?.delete(name.toLowerCase()));
  }

  count(answer) {
    if (!this.knowsPoll()) return 0;
    let total = 0;
    for (const vote of this.booth.values()) if (vote === answer) total += 1;
    return total;
  }

  getYesCount() {
    return this.count('yes');
  }

  getNoCount() {
    return this.count('no');
  }

  getAbstentionCount() {
    if (!this.knowsPoll()) return 0;
    return Math.max(0, this.suffraged.length - this.getYesCount() - this.getNoCount());
  }

  isPollSuccessful() {
    if (!this.knowsPoll()) return false;
    const yes = this.getYesCount();
    const no = this.getNoCount();
    const total = yes + no + this.getAbstentionCount();
    if (yes + no < this.votesRequired || yes + no === 0) return false;
    return (100 * yes) / total >= this.votePercentage;
  }

  timeRemaining() {
    if (!this.knowsPoll() || this.isPollSuccessful()) return 0;
    return Math.max(0, Math.floor(this.voteTime - this.elapsed()));
  }
}

// VoteCommand (commands.cxx:2859): every word upstream takes for each answer.
const YES_ANSWERS = new Set(['y', '1', 'yes', 'yea', 'si', 'ja', 'oui', 'sim', 'tak']);
const NO_ANSWERS = new Set(['n', '0', 'no', 'nay', 'nein', 'nien', 'non', 'nao', 'nie']);

function parseVoteAnswer(text) {
  const answer = String(text || '').trim().split(/\s+/)[0].toLowerCase();
  if (YES_ANSWERS.has(answer)) return { answer, vote: 'yes' };
  if (NO_ANSWERS.has(answer)) return { answer, vote: 'no' };
  return { answer, vote: null };
}

module.exports = { POLL_DEFAULTS, VotingArbiter, parseVoteAnswer };
