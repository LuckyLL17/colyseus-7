import { Room } from '../Room.ts';
import type { Client } from '../Transport.ts';
import type { IRoomCache } from '../matchmaker/driver.ts';
import * as matchMaker from '../MatchMaker.ts';
import { debugMatchMaking } from '../Debug.ts';
import { ServerError } from '../errors/ServerError.ts';
import { CloseCode, ErrorCode, type ISeatReservation } from '@colyseus/shared-types';

/**
 * Why a client is currently waiting. Sent to clients on every cycle so
 * callers can display human-readable queue status.
 */
export const QueueReason = {
  /** Still collecting players to fill a match. */
  GATHERING: 'gathering',
  /** The candidate's rank is too far from available groups. */
  RANK_MISMATCH: 'rank-mismatch',
  /** The candidate's region doesn't match available groups. */
  REGION_MISMATCH: 'region-mismatch',
  /** A whole team was skipped because adding it would overflow `maxPlayers`. */
  TEAM_TOO_LARGE: 'team-too-large',
  /** Waiting has crossed `maxWaitingCyclesForPriority` — relaxed matching. */
  PRIORITY_RELAXED: 'priority-relaxed',
  /** A seat reservation was issued; waiting for group confirmation. */
  MATCH_READY: 'match-ready',
  /** Dispatch failed (room creation / seat reservation) and was rolled back. */
  RETRYING: 'retrying',
} as const;
export type QueueReason = (typeof QueueReason)[keyof typeof QueueReason];

/**
 * Breakdown of a single candidate→group match evaluation. Exposed to
 * waiting clients so match scores are explainable instead of opaque.
 */
export interface QueueMatchScore {
  /**
   * Overall match score in the `[0, 1]` range. Higher is better.
   */
  total: number;

  /** Score contribution from waiting time (`[0, 1]`). */
  wait: number;

  /** Score contribution from rank proximity (`[0, 1]`). */
  rank: number;

  /** Score contribution from region proximity (`[0, 1]`). */
  region: number;

  /**
   * Hard-compatibility result. When `false`, the candidate is skipped
   * for this group (unless priority relaxation applies).
   */
  compatible: boolean;

  /** Human-readable reason explaining a skip or relaxation. */
  reason?: string;
}

export interface QueueStatus {
  /** Current waiting reason code. */
  reason: QueueReason;

  /** Estimated wait time, in milliseconds. */
  estimatedWaitTime: number;

  /** How long this client has been queued, in milliseconds. */
  waitingTime: number;

  /** Number of players in the client's current group. */
  groupSize: number;

  /** Number of players needed to complete a match. */
  missingPlayers: number;

  /** Last score evaluation, if the client was compared against a group. */
  lastScore?: QueueMatchScore;
}

export interface QueueOptions {
  /**
   * number of players on each match
   */
  maxPlayers?: number;

  /**
   * name of the room to create
   */
  matchRoomName: string;

  /**
   * after these cycles, create a match with a bot
   */
  maxWaitingCycles?: number;

  /**
   * after this time, try to fit this client with a not-so-compatible group
   */
  maxWaitingCyclesForPriority?: number;

  /**
   * If set, teams must have the same size to be matched together
   */
  maxTeamSize?: number;

  /**
   * If `allowIncompleteGroups` is true, players inside an unmatched group (that
   * did not reached `maxPlayers`, and `maxWaitingCycles` has been
   * reached) will be matched together. Your room should fill the remaining
   * spots with "bots" on this case.
   */
  allowIncompleteGroups?: boolean;

  /**
   * Comparison function for matching clients to groups
   * Returns true if the client is compatible with the group
   */
  compare?: (client: QueueClientData, matchGroup: QueueMatchGroup) => boolean;

  /**
   * Rank range treated as a full-score match. Rank differences larger
   * than this lose rank score linearly up to `rankRangeMax`.
   */
  rankRangeIdeal?: number;
  rankRangeMax?: number;

  /**
   * Region proximity map: `{ [from]: { [to]: number } }` with values in
   * the `[0, 1]` range (1 = same region). Clients without a `region`
   * always score 1 (region-neutral).
   */
  regionProximity?: { [from: string]: { [to: string]: number } };

  /**
   * Weights for the explainable match score. All default to 1.
   */
  scoreWeights?: { wait?: number; rank?: number; region?: number };

  /**
   * Extra milliseconds clients keep their seat reservation before it is
   * released back to the queue on top of `seatReservationTimeout`.
   * Caps how long a match-ready group may hold seats without confirming.
   */
  seatReservationGraceTime?: number;

  /**
   *
   * When onGroupReady is set, the "roomNameToCreate" option is ignored.
   */
  onGroupReady?: (this: QueueRoom, group: QueueMatchGroup) => Promise<IRoomCache>;
}

export interface QueueSeatReservation {
  room: IRoomCache;
  /** sessionId → released-by-rollback tracking */
  sessionIds: string[];
  /** absolute timestamp (ms) after which unconfirmed seats are released */
  expiresAt: number;
  /** rollback in progress guard, so a reservation is only released once */
  releasing?: Promise<void>;
  /** sessions whose "confirm" message was received */
  confirmedSessionIds: Set<string>;
}

export interface QueueMatchGroup {
  averageRank: number;
  clients: Array<Client<{ userData: QueueClientData }>>,
  ready?: boolean;
  confirmed?: number;

  /**
   * Seat reservation state for dispatched groups. While set, the group is
   * excluded from regrouping and its seats are tracked for safe transfer
   * or release on regroup/timeout/failure.
   */
  reservation?: QueueSeatReservation;
}

export interface QueueMatchTeam {
  averageRank: number;
  clients: Array<Client<{ userData: QueueClientData }>>,
  teamId: string | symbol;
}

export interface QueueClientData {
  /**
   * Rank of the client
   */
  rank: number;

  /**
   * Timestamp of when the client entered the queue
   */
  currentCycle?: number;

  /**
   * Wall-clock timestamp (ms) of when the client joined the queue.
   * Used for real waiting-time accounting, independent of cycle counts.
   */
  enqueuedAt?: number;

  /**
   * Optional region of the client (e.g. "us-east", "eu-west").
   */
  region?: string;

  /**
   * Optional: if matching with a team, the team ID
   */
  teamId?: string;

  /**
   * Additional options passed by the client when joining the room
   */
  options?: any;

  /**
   * Match group the client is currently in
   */
  group?: QueueMatchGroup;

  /**
   * Whether the client has confirmed the connection to the room
   */
  confirmed?: boolean;

  /**
   * Whether the client should be prioritized in the queue
   * (e.g. for players that are waiting for a long time)
   */
  highPriority?: boolean;

  /**
   * The last number of clients in the queue sent to the client
   */
  lastQueueClientCount?: number;

  /**
   * Current waiting reason and estimated wait time (sent as "status").
   */
  status?: QueueStatus;

  /**
   * While set (absolute timestamp, ms), status reporting keeps showing a
   * rollback/skip reason instead of overwriting it with GATHERING on the
   * same cycle that dispatched the group.
   */
  retainReasonUntil?: number;
}

//
// Optional: strongly-typed client messages
// (This is optional, but recommended for better type safety and code generation for native SDKs)
//
type QueueClient = Client<{
  userData: QueueClientData;
  messages: {
    clients: number;
    status: QueueStatus;
    seat: ISeatReservation;
  }
}>;

const DEFAULT_TEAM = Symbol("$default_team");
const DEFAULT_COMPARE = (client: QueueClientData, matchGroup: QueueMatchGroup) => {
  const diff = Math.abs(client.rank - matchGroup.averageRank);
  const diffRatio = (diff / matchGroup.averageRank);
  // If diff ratio is too high, create a new match group
  return (diff < 10 || diffRatio <= 2);
}

export class QueueRoom extends Room {
  maxPlayers = 4;
  maxTeamSize: number;
  allowIncompleteGroups: boolean = false;

  maxWaitingCycles = 15;
  maxWaitingCyclesForPriority?: number = 10;

  /**
   * Evaluate groups for each client at interval
   */
  cycleTickInterval = 1000;

  /**
   * Groups of players per iteration
   */
  groups: QueueMatchGroup[] = [];
  highPriorityGroups: QueueMatchGroup[] = [];

  matchRoomName: string;

  // — scoring configuration —
  rankRangeIdeal: number = 10;
  rankRangeMax: number = 100;
  regionProximity?: QueueOptions['regionProximity'];
  scoreWeights: { wait: number; rank: number; region: number } = { wait: 1, rank: 1, region: 1 };

  /** Extra time (ms) over seatReservationTimeout before reclaiming seats. */
  seatReservationGraceTime: number = 5000;

  protected compare = DEFAULT_COMPARE;
  protected onGroupReady = async function (this: QueueRoom, _group: QueueMatchGroup) {
    //
    // Reuse an existing unlocked room with enough free seats when one
    // exists, otherwise create a fresh one. Goes through the matchmaker
    // query layer so drivers/remote processes are respected.
    //
    const existing = await matchMaker.findRoomWithCapacity(this.matchRoomName, _group.clients.length);
    if (existing) {
      return existing;
    }
    return await matchMaker.createRoom(this.matchRoomName, {});
  };

  /**
   * Reservation windows of match-ready groups. Survives regrouping — the
   * groups themselves are rebuilt every cycle but reservations live here
   * until confirmed, transferred, timed out, or rolled back.
   */
  protected activeReservations: QueueSeatReservation[] = [];

  /** Recent enqueue timestamps (ms), for arrival-rate based ETA. */
  protected recentEnqueues: number[] = [];
  /** Recent observed wait durations (ms) of clients whose match dispatched. */
  protected recentDispatchWaits: number[] = [];

  messages = {
    confirm: (client: Client, _: unknown) => {
      const queueData = client.userData;

      if (queueData && queueData.group && typeof (queueData.group.confirmed) === "number") {
        queueData.confirmed = true;
        queueData.group.confirmed++;
        queueData.group.reservation?.confirmedSessionIds.add(client.sessionId);
        client.leave(CloseCode.NORMAL_CLOSURE);
      }
    },
  }

  onCreate(options: QueueOptions) {
    if (typeof(options.maxWaitingCycles) === "number") {
      this.maxWaitingCycles = options.maxWaitingCycles;
    }

    if (typeof(options.maxPlayers) === "number") {
      this.maxPlayers = options.maxPlayers;
    }

    if (typeof(options.maxTeamSize) === "number") {
      this.maxTeamSize = options.maxTeamSize;
    }

    if (typeof(options.allowIncompleteGroups) !== "undefined") {
      this.allowIncompleteGroups = options.allowIncompleteGroups;
    }

    if (typeof(options.compare) === "function") {
      this.compare = options.compare;
    }

    if (typeof(options.onGroupReady) === "function") {
      this.onGroupReady = options.onGroupReady;
    }

    if (typeof(options.rankRangeIdeal) === "number") {
      this.rankRangeIdeal = options.rankRangeIdeal;
    }

    if (typeof(options.rankRangeMax) === "number") {
      this.rankRangeMax = options.rankRangeMax;
    }

    if (options.regionProximity) {
      this.regionProximity = options.regionProximity;
    }

    if (options.scoreWeights) {
      this.scoreWeights = { ...this.scoreWeights, ...options.scoreWeights };
    }

    if (typeof(options.seatReservationGraceTime) === "number") {
      this.seatReservationGraceTime = options.seatReservationGraceTime;
    }

    if (options.matchRoomName) {
      this.matchRoomName = options.matchRoomName;

    } else {
      throw new ServerError(ErrorCode.APPLICATION_ERROR, "QueueRoom: 'matchRoomName' option is required.");
    }

    debugMatchMaking("QueueRoom#onCreate() maxPlayers: %d, maxWaitingCycles: %d, maxTeamSize: %d, allowIncompleteGroups: %d, roomNameToCreate: %s", this.maxPlayers, this.maxWaitingCycles, this.maxTeamSize, this.allowIncompleteGroups, this.matchRoomName);

    /**
     * Redistribute clients into groups at every interval
     */
    this.setTimestep(() => this.reassignMatchGroups(), this.cycleTickInterval);
  }

  onJoin(client: QueueClient, options: any, _auth?: unknown) {
    this.addToQueue(client, {
      rank: options.rank,
      region: options.region,
      teamId: options.teamId,
      options,
    });
  }

  addToQueue(client: QueueClient, queueData: QueueClientData) {
    if (queueData.currentCycle === undefined) {
      queueData.currentCycle = 0;
    }
    if (queueData.enqueuedAt === undefined) {
      queueData.enqueuedAt = Date.now();
    }
    client.userData = queueData;

    this.recentEnqueues.push(queueData.enqueuedAt);

    // FIXME: reassign groups upon joining [?] (without incrementing cycle count)
    client.send("clients", 1);
  }

  async onDispose() {
    //
    // Release every outstanding seat reservation on shutdown so rooms
    // created by in-flight dispatches don't hold quota until their own
    // seat timeout. Best-effort: never block disposal on it.
    //
    for (const reservation of [...this.activeReservations]) {
      if (!reservation.releasing) {
        reservation.releasing = this.rollbackReservation(reservation, 'failure').catch((e) => {
          debugMatchMaking(e);
        });
      }
    }
  }

  onLeave(client: QueueClient) {
    const userData = client.userData;

    const reservation = userData?.group?.reservation;
    if (!reservation) {
      return;
    }

    if (userData.confirmed) {
      // Client confirmed and left the queue for the match room: its seat
      // is consumed — just stop tracking it here.
      reservation.sessionIds = reservation.sessionIds.filter((sid) => sid !== client.sessionId);
      if (reservation.sessionIds.length === 0) {
        this.dropReservation(reservation);
      }

    } else {
      //
      // A client that already holds a seat but never confirmed: release
      // its seat immediately so the room (and the rest of the queue) is
      // not blocked until the reservation timeout fires.
      //
      this.releaseReservationForClients(userData.group!, [client]);
    }
  }

  createMatchGroup() {
    const group: QueueMatchGroup = { clients: [], averageRank: 0 };
    this.groups.push(group);
    return group;
  }

  // ---------------------------------------------------------------------------
  // Explainable scoring
  // ---------------------------------------------------------------------------

  /**
   * Score a candidate against a candidate group. Used both for the
   * greedy regrouping decision and for per-client status messages.
   */
  evaluateCandidate(client: QueueClient, group: QueueMatchGroup): QueueMatchScore {
    const userData = client.userData;
    const now = Date.now();

    //
    // wait: 0 at enqueue, ramps to 1 over maxWaitingCycles cycles.
    // Waiting longer never decreases an individual's score, and once the
    // priority threshold is crossed it saturates — long-waiting clients
    // are always preferred, but only for one dispatch at a time (their
    // reservation is reclaimed on timeout instead of being held forever).
    //
    const waitMs = Math.max(0, now - (userData.enqueuedAt ?? now));
    const waitWindowMs = Math.max(1, this.maxWaitingCyclesForPriority ?? this.maxWaitingCycles) * this.cycleTickInterval;
    const wait = Math.min(1, waitMs / waitWindowMs);

    //
    // rank: 1 within rankRangeIdeal, linear decay to 0 at rankRangeMax.
    //
    const rankDiff = Math.abs(userData.rank - group.averageRank);
    const rank = (rankDiff <= this.rankRangeIdeal)
      ? 1
      : Math.max(0, 1 - (rankDiff - this.rankRangeIdeal) / Math.max(1, this.rankRangeMax - this.rankRangeIdeal));

    //
    // region: explicit proximity table, same-region = 1, unknown = 0.5,
    // region-neutral clients (no region set) = 1.
    //
    let region = 1;
    if (userData.region && this.regionProximity) {
      const groupRegions = this.getGroupRegions(group);
      let best: number | undefined;
      for (const groupRegion of groupRegions) {
        const proximity = this.regionProximity[userData.region]?.[groupRegion];
        if (proximity !== undefined) {
          best = (best === undefined) ? proximity : Math.max(best, proximity);
        }
      }
      region = best ?? 0.5;
    }

    // custom/legacy hard compatibility gate
    const compatible = group.averageRank === 0 || this.compare(userData, group);

    const w = this.scoreWeights;
    const weightSum = Math.max(0.0001, w.wait + w.rank + w.region);
    const total = (wait * w.wait + rank * w.rank + region * w.region) / weightSum;

    return { total, wait, rank, region, compatible };
  }

  protected getGroupRegions(group: QueueMatchGroup): string[] {
    const regions = new Set<string>();
    for (const c of group.clients) {
      if (c.userData.region) {
        regions.add(c.userData.region);
      }
    }
    return [...regions];
  }

  /**
   * Pick the best open (not full) group for this client among the groups
   * already built during this redistribution pass. Returns `undefined`
   * when no group can host the candidate.
   */
  protected pickOpenGroup(client: QueueClient, groups: QueueMatchGroup[], allowRelaxed: boolean) {
    let best: { group: QueueMatchGroup; score: QueueMatchScore } | undefined;

    for (const group of groups) {
      if (group.clients.length >= this.maxPlayers || group.ready) {
        continue;
      }

      const score = this.evaluateCandidate(client, group);
      if (!score.compatible && !allowRelaxed) {
        continue;
      }

      if (best === undefined || score.total > best.score.total) {
        best = { group, score };
      }
    }

    return best;
  }

  // ---------------------------------------------------------------------------
  // Regrouping
  // ---------------------------------------------------------------------------

  reassignMatchGroups() {
    //
    // First, settle reservation lifecycle: reclaim expired seats and drop
    // fully-confirmed groups. Clients whose seats are released return to
    // the queue below.
    //
    this.sweepReservations();

    // Re-set candidate groups (groups with live reservations are kept
    // alive through `activeReservations`, not through this array).
    this.groups.length = 0;
    this.highPriorityGroups.length = 0;

    const sortedClients = (this.clients)      .filter((client) => {
        // Filter out:
        // - clients that are not in the queue
        // - clients that already hold a seat reservation
        // - clients whose group dispatch is in flight (ready, awaiting
        //   room creation / seat reservation)
        return (
          client.userData &&
          client.userData.group?.reservation === undefined &&
          client.userData.group?.ready !== true
        );
      })
      .sort((a, b) => {
        //
        // Sort by rank ascending; longer-waiting clients come first on a
        // tie so the explainable score has a stable, fairness-preserving
        // tie-breaker.
        //
        if (a.userData.rank !== b.userData.rank) {
          return a.userData.rank - b.userData.rank;
        }
        return (a.userData.enqueuedAt ?? 0) - (b.userData.enqueuedAt ?? 0);
      });

    //
    // The room either distribute by teams or by clients
    //
    if (typeof(this.maxTeamSize) === "number") {
      this.redistributeTeams(sortedClients);

    } else {
      this.redistributeClients(sortedClients);
    }

    // NOTE: a trailing empty group is intentionally kept here — the
    // original public behaviour exposes `groups.length` including it, and
    // existing consumers/tests rely on that count. It carries no clients,
    // so it never receives status updates or dispatches.

    this.evaluateHighPriorityGroups();
    this.processGroupsReady();
    this.broadcastQueueStatus();
  }

  redistributeTeams(sortedClients: Client<{ userData: QueueClientData }>[]) {
    const teamsByID: { [teamId: string | symbol]: QueueMatchTeam } = {};

    sortedClients.forEach((client) => {
      const teamId = client.userData.teamId || DEFAULT_TEAM;

      // Create a new team if it doesn't exist
      if (!teamsByID[teamId]) {
        teamsByID[teamId] = { teamId: teamId, clients: [], averageRank: 0, };
      }

      teamsByID[teamId].averageRank += client.userData.rank;
      teamsByID[teamId].clients.push(client);
    });

    // Calculate average rank for each team
    let teams = Object.values(teamsByID).map((team) => {
      team.averageRank /= team.clients.length;
      return team;
    }).sort((a, b) => {
      // Sort by average rank ascending
      return a.averageRank - b.averageRank;
    });

    // Iterate over teams multiple times until all clients are assigned to a group
    do {
      let currentGroup: QueueMatchGroup = this.createMatchGroup();
      teams = teams.filter((team) => {
        if (team.clients.length === 0) {
          return false;
        }

        const chunkSize = Math.min(this.maxTeamSize, team.clients.length);

        //
        // Whole-team size guard: a team chunk is only placed when it fits
        // the open group. If it doesn't fit anywhere (group would exceed
        // maxPlayers), the chunk is skipped for this redistribution — its
        // members keep waiting with TEAM_TOO_LARGE instead of overflowing
        // or silently merging with incompatible ranks.
        //
        if (currentGroup.clients.length + chunkSize > this.maxPlayers) {
          team.clients.forEach((client) => {
            client.userData.group = undefined;
            client.userData.status = {
              ...(client.userData.status as QueueStatus),
              reason: QueueReason.TEAM_TOO_LARGE,
            } as QueueStatus;
            client.userData.currentCycle++;
          });

          // keep this team for the next outer iteration (it still has
          // clients), unless it was fully exhausted of splittable chunks
          return team.clients.length > 0;
        }

        // detach the chunk and place every member into the current group
        const chunk = team.clients.splice(0, chunkSize);
        const totalRank = team.averageRank * chunk.length;
        currentGroup = this.redistributeClients(chunk, currentGroup, totalRank, chunk.length);

        if (team.clients.length >= this.maxTeamSize) {
          // team still has enough clients to form another chunk
          return true;
        }

        // increment cycle count for leftover clients in the team
        team.clients.forEach((client) => client.userData.currentCycle++);

        return false;
      });
    } while (teams.length >= 2);
  }

  redistributeClients(
    sortedClients: Client<{ userData: QueueClientData }>[],
    currentGroup: QueueMatchGroup = this.createMatchGroup(),
    totalRank: number = 0,
    /**
     * Number of slots that must be available to accept this batch. 1 in
     * regular (per-client) mode, the team chunk size under maxTeamSize —
     * whole teams are skipped when they don't fit instead of overflowing
     * a group.
     */
    requiredSlots: number = 1,
  ) {
    //
    // Team-mode guard: if the entire batch cannot fit in the current
    // group nor any fresh group, the whole team is skipped for this
    // redistribution (it keeps waiting with TEAM_TOO_LARGE).
    //
    if (
      requiredSlots > 1 &&
      currentGroup.clients.length + requiredSlots > this.maxPlayers
    ) {
      for (const teammate of sortedClients) {
        teammate.userData.group = undefined;
        teammate.userData.status = {
          ...(teammate.userData.status as QueueStatus),
          reason: QueueReason.TEAM_TOO_LARGE,
        } as QueueStatus;
      }
      return currentGroup;
    }

    for (let i = 0, l = sortedClients.length; i < l; i++) {
      const client = sortedClients[i] as QueueClient;
      const userData = client.userData;
      const currentCycle = userData.currentCycle++;

      //
      // highPriority is a carried-over flag from previous cycles: it is
      // set at the END of this iteration and only takes effect on the
      // next redistribution. This preserves the original relaxation
      // timing (clients wait a full threshold of cycles before forcing
      // merges) while still guaranteeing seats can't be held forever —
      // reservations are bounded by reservationTimeoutMs regardless.
      //
      const allowRelaxed = !!userData.highPriority;

      // A full current group can never accept more candidates (it was
      // already marked ready and replaced in single-client mode, but team
      // chunks may leave it full here).
      if (currentGroup.clients.length >= this.maxPlayers) {
        currentGroup = this.createMatchGroup();
        totalRank = 0;
      }

      let chosen: { group: QueueMatchGroup; score: QueueMatchScore } | undefined;

      if (requiredSlots === 1 && this.groups.some((g) => g.clients.length > 0)) {
        chosen = this.pickOpenGroup(client, this.groups, allowRelaxed);
      }

      if (chosen !== undefined) {
        currentGroup = chosen.group;
        totalRank = currentGroup.averageRank * currentGroup.clients.length;
        userData.status = {
          ...(userData.status as QueueStatus),
          reason: allowRelaxed && !chosen.score.compatible ? QueueReason.PRIORITY_RELAXED : QueueReason.GATHERING,
          lastScore: chosen.score,
        } as QueueStatus;

      } else if (currentGroup.clients.length > 0 && requiredSlots === 1) {
        //
        // Single candidate doesn't fit any existing group: skip it for
        // this round and open a fresh group (candidate becomes its first
        // member). The skipped-against score is recorded on status so
        // callers see *why* the user is waiting.
        //
        const scoreAgainstCurrent = this.evaluateCandidate(client, currentGroup);
        currentGroup = this.createMatchGroup();
        totalRank = 0;
        userData.status = {
          ...(userData.status as QueueStatus),
          reason: this.describeSkipReason(userData, scoreAgainstCurrent),
          lastScore: scoreAgainstCurrent,
        } as QueueStatus;

      } else if (currentGroup.clients.length > 0) {
        // Team chunk: teammates always stay together in the current
        // group. Relaxation status is still surfaced when ranks diverge.
        const scoreAgainstCurrent = this.evaluateCandidate(client, currentGroup);
        userData.status = {
          ...(userData.status as QueueStatus),
          reason: (!scoreAgainstCurrent.compatible && allowRelaxed)
            ? QueueReason.PRIORITY_RELAXED
            : QueueReason.GATHERING,
          lastScore: scoreAgainstCurrent,
        } as QueueStatus;
      }

      userData.group = currentGroup;
      currentGroup.clients.push(client);

      totalRank += userData.rank;
      currentGroup.averageRank = totalRank / currentGroup.clients.length;

      // Enough players in the group, mark it as ready!
      if (currentGroup.clients.length === this.maxPlayers) {
        currentGroup.ready = true;
        currentGroup = this.createMatchGroup();
        totalRank = 0;
        continue;
      }

      if (currentCycle >= this.maxWaitingCycles && this.allowIncompleteGroups) {
        /**
         * Match long-waiting clients with bots
         */
        if (this.highPriorityGroups.indexOf(currentGroup) === -1) {
          this.highPriorityGroups.push(currentGroup);
        }
      }

      //
      // Mark long-waiting clients for relaxed matching on the NEXT
      // redistribution. Flag is intentionally carried over instead of
      // reset every cycle so clients that crossed the threshold remain
      // relaxed; seats they may obtain are still time-bounded.
      //
      if (
        this.maxWaitingCyclesForPriority !== undefined &&
        currentCycle >= this.maxWaitingCyclesForPriority
      ) {
        userData.highPriority = true;

        if (!userData.status || userData.status.reason === QueueReason.GATHERING) {
          userData.status = {
            ...(userData.status as QueueStatus),
            reason: QueueReason.PRIORITY_RELAXED,
          } as QueueStatus;
        }
      }
    }

    return currentGroup;
  }

  protected describeSkipReason(userData: QueueClientData, score: QueueMatchScore): QueueReason {
    if (userData.region && score.region <= 0.5 && score.rank > score.region) {
      return QueueReason.REGION_MISMATCH;
    }
    if (!score.compatible || score.rank <= 0) {
      return QueueReason.RANK_MISMATCH;
    }
    if (userData.region && score.region <= 0.5) {
      return QueueReason.REGION_MISMATCH;
    }
    return QueueReason.GATHERING;
  }

  evaluateHighPriorityGroups() {
    /**
     * Evaluate groups with high priority clients
     */
    this.highPriorityGroups.forEach((group) => {
      group.ready = group.clients.every((c) => {
        // Give new clients another chance to join a group that is not "high priority"
        return c.userData?.currentCycle > 1;
        // return c.userData?.currentCycle >= this.maxWaitingCycles;
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Seat reservation lifecycle
  // ---------------------------------------------------------------------------

  protected reservationTimeoutMs() {
    return (this.seatReservationTimeout * 1000) + this.seatReservationGraceTime;
  }

  /**
   * Thin wrappers over the matchmaker rollback API. Kept as overridable
   * methods so subclasses/tests can intercept seat reservation calls
   * without touching the (read-only) matchmaker namespace export.
   */
  protected reserveSeats(
    room: IRoomCache,
    clientsData: Array<{ sessionId: string, options: any, auth: any }>,
  ): Promise<boolean[]> {
    return matchMaker.reserveMultipleSeatsFor(room, clientsData);
  }

  protected releaseSeats(room: IRoomCache, sessionIds: string[]): Promise<boolean[]> {
    return matchMaker.releaseSeatsFor(room, sessionIds);
  }

  protected disposeEmptyRoom(room: IRoomCache): Promise<boolean> {
    return matchMaker.disposeRoomIfEmpty(room);
  }

  /**
   * Reclaim expired reservations and forget fully-confirmed ones.
   * Safe to run every cycle: already-releasing reservations are awaited
   * instead of released twice.
   */
  protected sweepReservations() {
    const now = Date.now();
    const remaining: QueueSeatReservation[] = [];

    for (const reservation of this.activeReservations) {
      if (reservation.releasing) {
        // rollback in progress — keep tracking until the next sweep
        remaining.push(reservation);
        continue;
      }

      if (reservation.sessionIds.length === 0) {
        // every seat either confirmed-and-left or released — drop tracking
        debugMatchMaking('QueueRoom: group fully confirmed/cleared, dropping reservation for room \'%s\'', reservation.room.roomId);
        continue;
      }

      if (now >= reservation.expiresAt) {
        debugMatchMaking('QueueRoom: reservation timed out for room \'%s\' — releasing seats back to queue', reservation.room.roomId);
        reservation.releasing = this.rollbackReservation(reservation, 'timeout').catch((e) => {
          debugMatchMaking(e);
        });
        remaining.push(reservation);
        continue;
      }

      remaining.push(reservation);
    }

    this.activeReservations = remaining;
  }

  /**
   * Release the seats of specific clients in a group's reservation.
   * Used when clients leave without confirming. Other clients keep
   * their seats — the reservation "transfers" to the smaller set.
   */
  protected releaseReservationForClients(
    group: QueueMatchGroup,
    clients: Array<Client<{ userData: QueueClientData }>>,
  ) {
    const reservation = group.reservation;
    if (!reservation || reservation.releasing) {
      return;
    }

    const sessionIds = clients.map((c) => c.sessionId);
    reservation.sessionIds = reservation.sessionIds.filter((sid) => !sessionIds.includes(sid));

    this.releaseSeats(reservation.room, sessionIds)
      .then((results) => {
        const released = results.filter(Boolean).length;
        debugMatchMaking(
          'QueueRoom: released %d/%d unconfirmed seat(s) from room \'%s\'',
          released, sessionIds.length, reservation.room.roomId,
        );

        if (reservation.sessionIds.length === 0) {
          this.dropReservation(reservation);
        }
      })
      .catch((e) => debugMatchMaking(e));
  }

  /**
   * Full rollback of a reservation: every unconfirmed seat is released,
   * an empty room is disposed, and the re-queued clients get a RETRYING
   * reason. Already-confirming clients keep their seats.
   */
  protected async rollbackReservation(reservation: QueueSeatReservation, _cause: 'timeout' | 'failure') {
    const unconfirmed = reservation.sessionIds.filter((sid) => !reservation.confirmedSessionIds.has(sid));

    try {
      const results = await this.releaseSeats(reservation.room, unconfirmed);

      // Clients that didn't make it into the room are re-queued: clear
      // their group pointer so the next redistribution picks them up.
      unconfirmed.forEach((sessionId, i) => {
        if (results[i]) {
          const client = this.clients.find((c) => c.sessionId === sessionId);
          if (client) {
            client.userData.group = undefined;
            this.setRetainedReason(client as QueueClient, QueueReason.RETRYING);
            client.send("status", this.buildQueueStatus(client as QueueClient));
          }
        }
      });

      // Only dispose when nobody consumed any seat (no confirmations at
      // all and every release succeeded) — don't touch rooms that have
      // clients connecting into them.
      if (reservation.confirmedSessionIds.size === 0 && results.length > 0 && results.every(Boolean)) {
        await this.disposeEmptyRoom(reservation.room);
      }

    } finally {
      this.dropReservation(reservation);
    }
  }

  protected dropReservation(reservation: QueueSeatReservation) {
    const index = this.activeReservations.indexOf(reservation);
    if (index !== -1) {
      this.activeReservations.splice(index, 1);
    }
  }

  processGroupsReady() {
    this.groups.forEach((group) => {
      if (group.ready && group.reservation === undefined) {
        group.confirmed = 0;
        this.dispatchGroup(group);
      }
    });
  }

  /**
   * Create (or reuse) a room and reserve seats for the whole group.
   * On any failure the group is rolled back into the queue instead of
   * being disconnected — room creation failure must not evict waiting
   * users, and high-priority users don't keep seats across retries.
   */
  protected async dispatchGroup(group: QueueMatchGroup) {
    let room: IRoomCache;

    try {
      /**
       * Create room instance in the server (or reuse one with capacity).
       */
      room = await this.onGroupReady.call(this, group);

      /**
       * Guard against room size mismatch: if the target room can't fit
       * the whole group, skip this dispatch instead of reserving a
       * partial set. Clients stay queued with a visible reason.
       */
      const freeSeats = room.maxClients - room.clients;
      if (freeSeats < group.clients.length) {
        group.ready = false;
        group.clients.forEach((client) => {
          this.setRetainedReason(client, QueueReason.TEAM_TOO_LARGE);
        });
        debugMatchMaking(
          'QueueRoom: room \'%s\' cannot fit group of %d (free seats: %d) — skipping',
          room.roomId, group.clients.length, freeSeats,
        );

        // the in-cycle status broadcast already happened before this
        // async guard resolved — push the updated reason now
        group.clients.forEach((client) => client.send("status", this.buildQueueStatus(client)));
        return;
      }

      /**
       * Reserve a seat for each client in the group — atomically.
       * `_reserveMultipleSeats` returns all-false without reserving
       * anything when capacity is insufficient.
       */
      const results = await this.reserveSeats(
        room,
        group.clients.map((client) => ({
          sessionId: client.sessionId,
          options: client.userData.options,
          auth: client.auth,
        })),
      );

      if (results.some((ok) => !ok)) {
        throw new ServerError(ErrorCode.MATCHMAKE_EXPIRED, `room "${room.roomId}" cannot reserve all seats for the group`);
      }

      /**
       * Track the reservation so it safely transfers/releases across
       * regrouping, confirmation timeouts, and queue shutdown.
       */
      const reservation: QueueSeatReservation = {
        room,
        sessionIds: group.clients.map((c) => c.sessionId),
        expiresAt: Date.now() + this.reservationTimeoutMs(),
        confirmedSessionIds: new Set<string>(),
      };
      group.reservation = reservation;
      this.activeReservations.push(reservation);

      // observed wait time feeds the ETA estimator
      const now = Date.now();
      group.clients.forEach((client) => {
        const waited = now - (client.userData.enqueuedAt ?? now);
        this.recentDispatchWaits.push(waited);

        client.userData.status = {
          ...(client.userData.status as QueueStatus),
          reason: QueueReason.MATCH_READY,
          groupSize: group.clients.length,
          missingPlayers: 0,
        } as QueueStatus;
      });

      /**
       * Send room data for new WebSocket connection!
       */
      group.clients.forEach((client) => {
        client.send("seat", matchMaker.buildSeatReservation(room, client.sessionId));
      });

    } catch (e: any) {
      //
      // Room creation or seat reservation failed — re-queue everyone.
      // No reservation was created (the batch call is atomic), so there
      // is nothing to release; clients retry on the next cycle.
      //
      debugMatchMaking('QueueRoom: dispatch failed, re-queueing group: %s', e?.message ?? e);

      group.ready = false;
      group.clients.forEach((client) => {
        client.userData.group = undefined;
        this.setRetainedReason(client, QueueReason.RETRYING);
        client.send("status", this.buildQueueStatus(client));
      });
    }
  }

  /**
   * Stamp a reason that must survive the status broadcast on the same
   * cycle (rollback/skip paths run after redistribution set GATHERING).
   */
  protected setRetainedReason(client: QueueClient, reason: QueueReason) {
    client.userData.status = {
      ...(client.userData.status as QueueStatus),
      reason,
    } as QueueStatus;
    // retained until the end of the next cycle (~2 ticks)
    client.userData.retainReasonUntil = Date.now() + (this.cycleTickInterval * 2);
  }

  // ---------------------------------------------------------------------------
  // Queue status ("why am I waiting?" + ETA)
  // ---------------------------------------------------------------------------

  /**
   * Estimated wait time in milliseconds for a waiting client.
   *
   * Blends:
   *  - an arrival-rate projection: missing players / recent arrival rate
   *  - the empirical median wait of recently dispatched players
   */
  protected estimateWaitTime(group: QueueMatchGroup | undefined): number {
    const now = Date.now();
    const windowMs = Math.max(this.maxWaitingCycles, 1) * this.cycleTickInterval * 2;

    this.recentEnqueues = this.recentEnqueues.filter((t) => now - t <= windowMs);

    const groupSize = group?.clients.length ?? 1;
    const missing = Math.max(0, this.maxPlayers - groupSize);

    // arrivals per second within the observation window
    const windowSeconds = windowMs / 1000;
    const arrivalRate = this.recentEnqueues.length / Math.max(1, windowSeconds);

    const rateBasedEta = (arrivalRate > 0)
      ? (missing / arrivalRate) * 1000
      // no recent arrivals: assume one full window of waiting at most
      : missing * this.maxWaitingCycles * this.cycleTickInterval;

    let empiricalEta: number | undefined;
    if (this.recentDispatchWaits.length > 0) {
      const sorted = [...this.recentDispatchWaits].sort((a, b) => a - b);
      empiricalEta = sorted[Math.floor(sorted.length / 2)];
      // keep the rolling sample bounded
      if (this.recentDispatchWaits.length > 50) {
        this.recentDispatchWaits.splice(0, this.recentDispatchWaits.length - 50);
      }
    }

    // Incomplete groups can dispatch as soon as maxWaitingCycles elapses —
    // never report an ETA beyond that ceiling.
    const ceiling = this.allowIncompleteGroups
      ? this.maxWaitingCycles * this.cycleTickInterval
      : this.maxPlayers * this.maxWaitingCycles * this.cycleTickInterval;

    let eta: number;
    if (empiricalEta !== undefined) {
      // trust observed throughput, but never under-report missing arrivals
      eta = Math.max(empiricalEta, rateBasedEta);
    } else {
      eta = rateBasedEta;
    }

    return Math.max(0, Math.min(ceiling, Math.round(eta)));
  }

  protected buildQueueStatus(client: QueueClient): QueueStatus {
    const userData = client.userData;
    const group = userData.group;
    const groupSize = group?.clients.length ?? 0;
    const waitingTime = Date.now() - (userData.enqueuedAt ?? Date.now());

    let reason: QueueReason;
    if (group?.reservation) {
      reason = QueueReason.MATCH_READY;
    } else if (
      userData.retainReasonUntil !== undefined &&
      Date.now() < userData.retainReasonUntil &&
      userData.status?.reason &&
      userData.status.reason !== QueueReason.GATHERING
    ) {
      // Rollback/skip happened on (or just before) this cycle — keep
      // explaining it until the next redistribution reassesses.
      reason = userData.status.reason;
    } else {
      reason = userData.status?.reason ?? QueueReason.GATHERING;
      if (userData.retainReasonUntil !== undefined && Date.now() >= userData.retainReasonUntil) {
        userData.retainReasonUntil = undefined;
      }
    }

    const status: QueueStatus = {
      reason,
      estimatedWaitTime: this.estimateWaitTime(group),
      waitingTime: Math.max(0, waitingTime),
      groupSize,
      missingPlayers: (group?.reservation) ? 0 : Math.max(0, this.maxPlayers - groupSize),
      lastScore: userData.status?.lastScore,
    };

    userData.status = status;
    return status;
  }

  protected broadcastQueueStatus() {
    (this.clients as QueueClient[]).forEach((client) => {
      if (!client.userData) {
        return;
      }

      // Clients holding a seat: keep their match-ready status but don't
      // recompute "missing players" every cycle.
      const status = this.buildQueueStatus(client);

      client.send("status", status);

      //
      // Backwards-compatible "clients" notification (avoid sending the
      // same group size twice).
      //
      const queueClientCount = status.groupSize;
      if (client.userData.lastQueueClientCount !== queueClientCount) {
        client.userData.lastQueueClientCount = queueClientCount;
        client.send("clients", queueClientCount);
      }
    });
  }

}
