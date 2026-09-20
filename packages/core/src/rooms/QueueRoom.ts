import { Room } from '../Room.ts';
import type { Client } from '../Transport.ts';
import type { IRoomCache } from '../matchmaker/driver.ts';
import * as matchMaker from '../MatchMaker.ts';
import { debugMatchMaking } from '../Debug.ts';
import { ServerError } from '../errors/ServerError.ts';
import { CloseCode, ErrorCode } from '@colyseus/shared-types';

/**
 * Reasons a client is still waiting in the queue.
 * (Exposed to callers via the "queue" message and `getQueueStatus()`)
 */
export const QueueReason = {
  /**
   * The group does not have enough players yet.
   */
  WAITING_FOR_PLAYERS: 'waiting_for_players',

  /**
   * Other players are waiting, but none are compatible with this client's
   * group (e.g. rank difference too high).
   */
  WAITING_FOR_COMPATIBLE_GROUP: 'waiting_for_compatible_group',

  /**
   * The client's team does not fit the remaining slots of any open group.
   */
  TEAM_SIZE_MISMATCH: 'team_size_mismatch',

  /**
   * A match was found and the client should confirm its seat reservation.
   */
  AWAITING_CONFIRMATION: 'awaiting_confirmation',
} as const;
export type QueueReason = typeof QueueReason[keyof typeof QueueReason];

/**
 * Weight of each factor on the matchmaking score.
 * (Also the shape of each scored component, each ranging from 0 to 1)
 */
export interface QueueScoreFactors {
  /**
   * How long the client has been waiting. Reaches 1 when the client is
   * promoted to "high priority" (`maxWaitingCyclesForPriority`).
   */
  wait: number;

  /**
   * Rank compatibility between the client and its group (1 = identical rank).
   */
  rank: number;

  /**
   * Region compatibility between the client and its group (1 = same region,
   * or no region information provided).
   */
  region: number;
}

/**
 * Explainable matchmaking score: the `total` is a weighted sum of each
 * component, so callers can explain exactly why a client is (not) being
 * matched.
 */
export interface QueueScoreBreakdown {
  /**
   * Weighted total score (0..1 with default weights).
   */
  total: number;

  /**
   * Individual score of each factor (0..1 each).
   */
  components: QueueScoreFactors;

  /**
   * Weights applied to each factor.
   */
  weights: QueueScoreFactors;
}

/**
 * Queue status sent to clients on every cycle (and queryable server-side
 * through `queueRoom.getQueueStatus(client)`).
 */
export interface QueueClientStatus {
  /**
   * Number of clients currently in the same group.
   */
  clients: number;

  /**
   * How many more players are needed to fill the group.
   */
  needed: number;

  /**
   * Why the client is still waiting.
   */
  reason: QueueReason;

  /**
   * Estimated time (in milliseconds) until this client is matched.
   * `null` when there is not enough information to estimate.
   */
  estimatedWaitMs: number | null;

  /**
   * Explainable matchmaking score for this client.
   */
  score: QueueScoreBreakdown;
}

/**
 * Queue-wide statistics, published on the room's metadata under the `queue`
 * key. Queryable through `matchMaker.query()` / `matchMaker.getQueueStats()`.
 */
export interface QueueRoomStats {
  /**
   * Number of clients waiting in the queue.
   */
  clients: number;

  /**
   * Number of groups currently being formed.
   */
  groups: number;

  /**
   * Average amount of cycles clients have been waiting.
   */
  averageWaitCycles: number;

  /**
   * Average estimated wait (in milliseconds) across waiting clients.
   * `null` when there is not enough information to estimate.
   */
  estimatedWaitMs: number | null;

  /**
   * Timestamp of when these stats were computed.
   */
  updatedAt: number;
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
   * Scoring function for waiting clients. Receives the client and its current
   * group (if any), and returns either a weighted total (number) or a full
   * `QueueScoreBreakdown` for maximum explainability.
   *
   * Defaults to a score based on waiting time, rank and region.
   */
  score?: (client: QueueClientData, matchGroup: QueueMatchGroup | undefined) => number | QueueScoreBreakdown;

  /**
   * Weights for each factor of the default score. Unset factors keep their
   * default values ({ wait: 0.5, rank: 0.3, region: 0.2 }).
   */
  scoreWeights?: Partial<QueueScoreFactors>;

  /**
   * How many cycles a "ready" group waits for client confirmations before
   * their seat reservations are released and unconfirmed clients are
   * re-queued. Prevents no-show clients from holding seats indefinitely.
   * (default: 5)
   */
  maxConfirmationCycles?: number;

  /**
   * How many times a client is re-queued after a failed seat reservation
   * before being disconnected. (default: 2)
   */
  maxReservationRetries?: number;

  /**
   * When a room is created for a group but the seat reservation fails,
   * dispose the created room. Disable if your custom `onGroupReady` returns
   * rooms that are shared/reused elsewhere. (default: true)
   */
  rollbackCreatedRoom?: boolean;

  /**
   *
   * When onGroupReady is set, the "roomNameToCreate" option is ignored.
   */
  onGroupReady?: (this: QueueRoom, group: QueueMatchGroup) => Promise<IRoomCache>;
}

export interface QueueMatchGroup {
  averageRank: number;
  clients: Array<Client<{ userData: QueueClientData }>>,
  ready?: boolean;
  confirmed?: number;

  /**
   * Region of the first client assigned to this group.
   */
  region?: string;

  /**
   * Active seat reservation for this group (set once the target room has
   * been created and seats reserved). Used to release seats of clients that
   * never confirm.
   */
  reservation?: {
    room: IRoomCache;
    cycle: number;
  };
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
   * Optional: region of the client (e.g. "us-east", "eu-west").
   * Used as a factor of the matchmaking score.
   */
  region?: string;

  /**
   * Timestamp (Date.now()) of when the client entered the queue
   */
  enqueuedAt?: number;

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
   * Last computed score for this client (see `QueueScoreBreakdown`)
   */
  lastScore?: QueueScoreBreakdown;

  /**
   * Why the client is still waiting (see `QueueReason`)
   */
  queueReason?: QueueReason;

  /**
   * How many times a seat reservation failed for this client
   */
  reservationRetries?: number;
}

//
// Optional: strongly-typed client messages
// (This is optional, but recommended for better type safety and code generation for native SDKs)
//
type QueueClient = Client<{
  userData: QueueClientData;
  messages: {
    clients: number;
    queue: QueueClientStatus;
    seat: matchMaker.ISeatReservation;
  }
}>;

const DEFAULT_TEAM = Symbol("$default_team");
const DEFAULT_COMPARE = (client: QueueClientData, matchGroup: QueueMatchGroup) => {
  const diff = Math.abs(client.rank - matchGroup.averageRank);
  const diffRatio = (diff / matchGroup.averageRank);
  // If diff ratio is too high, create a new match group
  return (diff < 10 || diffRatio <= 2);
}

const DEFAULT_SCORE_WEIGHTS: QueueScoreFactors = { wait: 0.5, rank: 0.3, region: 0.2 };

/**
 * How many recent cycles are considered when estimating the join rate of the
 * queue (used for the estimated wait time).
 */
const JOIN_RATE_WINDOW = 10;

export class QueueRoom extends Room {
  maxPlayers = 4;
  maxTeamSize: number;
  allowIncompleteGroups: boolean = false;

  maxWaitingCycles = 15;
  maxWaitingCyclesForPriority?: number = 10;

  /**
   * How many cycles a "ready" group waits for confirmations before releasing
   * the seats of unconfirmed clients and re-queueing them.
   */
  maxConfirmationCycles = 5;

  /**
   * How many times a client is re-queued after a failed seat reservation
   * before being disconnected.
   */
  maxReservationRetries = 2;

  /**
   * Whether to dispose the created room when its seat reservation fails.
   */
  rollbackCreatedRoom = true;

  /**
   * Weights of each factor for the default score.
   */
  scoreWeights: QueueScoreFactors = { ...DEFAULT_SCORE_WEIGHTS };

  /**
   * Evaluate groups for each client at interval
   */
  cycleTickInterval = 1000;

  /**
   * Groups of players per iteration
   */
  groups: QueueMatchGroup[] = [];
  highPriorityGroups: QueueMatchGroup[] = [];

  /**
   * "Ready" groups waiting for clients to confirm their seat reservation.
   * Groups stay here until every client confirmed, or until
   * `maxConfirmationCycles` elapses (then pending seats are released).
   */
  pendingConfirmation: QueueMatchGroup[] = [];

  matchRoomName: string;

  protected compare = DEFAULT_COMPARE;
  protected score?: (client: QueueClientData, matchGroup: QueueMatchGroup | undefined) => number | QueueScoreBreakdown;
  protected onGroupReady = (group: QueueMatchGroup) => matchMaker.createRoom(this.matchRoomName, {});

  /**
   * Number of redistribution cycles elapsed since room creation.
   */
  protected cycleCount = 0;

  /**
   * Join-rate tracking (for estimated wait time)
   */
  private joinsSinceLastCycle = 0;
  private joinRateWindow: number[] = [];

  /**
   * Last published queue stats (JSON), to avoid persisting unchanged metadata.
   */
  private lastPublishedStats?: string;

  messages = {
    confirm: (client: Client, _: unknown) => {
      const queueData = client.userData;

      if (queueData && queueData.group && typeof (queueData.group.confirmed) === "number") {
        queueData.confirmed = true;
        queueData.group.confirmed++;
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

    if (typeof(options.score) === "function") {
      this.score = options.score;
    }

    if (options.scoreWeights) {
      this.scoreWeights = { ...this.scoreWeights, ...options.scoreWeights };
    }

    if (typeof(options.maxConfirmationCycles) === "number") {
      this.maxConfirmationCycles = options.maxConfirmationCycles;
    }

    if (typeof(options.maxReservationRetries) === "number") {
      this.maxReservationRetries = options.maxReservationRetries;
    }

    if (typeof(options.rollbackCreatedRoom) !== "undefined") {
      this.rollbackCreatedRoom = options.rollbackCreatedRoom;
    }

    if (typeof(options.onGroupReady) === "function") {
      this.onGroupReady = options.onGroupReady;
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

  onJoin(client: QueueClient, options: any, auth?: unknown) {
    options = options || {};

    this.addToQueue(client, {
      rank: options.rank,
      teamId: options.teamId,
      region: options.region,
      options,
    });
  }

  onLeave(client: QueueClient) {
    const userData = client.userData;
    const group = userData?.group;

    //
    // Release the seat this client was holding on a "ready" group, so
    // disconnected clients never hold seats indefinitely.
    // (confirmed clients have their seats consumed by the target room)
    //
    if (group?.ready && group.reservation && !userData?.confirmed) {
      matchMaker.releaseMultipleSeatsFor(group.reservation.room, [client.sessionId])
        .catch((e) => debugMatchMaking("QueueRoom: failed to release seat on leave: %s", e?.message ?? e));
    }
  }

  addToQueue(client: QueueClient, queueData: QueueClientData) {
    if (queueData.currentCycle === undefined) {
      queueData.currentCycle = 0;
    }

    if (queueData.enqueuedAt === undefined) {
      queueData.enqueuedAt = Date.now();
    }

    client.userData = queueData;
    this.joinsSinceLastCycle++;

    // FIXME: reassign groups upon joining [?] (without incrementing cycle count)
    client.send("clients", 1);
    client.send("queue", this.getQueueStatus(client));
  }

  createMatchGroup() {
    const group: QueueMatchGroup = { clients: [], averageRank: 0 };
    this.groups.push(group);
    return group;
  }

  reassignMatchGroups() {
    this.cycleCount++;

    /**
     * Release seats of "ready" groups whose clients never confirmed.
     * (unconfirmed clients are re-queued and redistributed below)
     */
    this.evaluatePendingConfirmations();

    // Re-set all groups
    this.groups.length = 0;
    this.highPriorityGroups.length = 0;

    const sortedClients = (this.clients)
      .filter((client) => {
        // Filter out:
        // - clients that are not in the queue
        // - clients that are already in a "ready" group
        return (
          client.userData &&
          client.userData.group?.ready !== true
        );
      })
      .sort((a, b) => {
        //
        // Sort by rank ascending
        //
        return a.userData.rank - b.userData.rank;
      });

    //
    // The room either distribute by teams or by clients
    //
    if (typeof(this.maxTeamSize) === "number") {
      this.redistributeTeams(sortedClients);

    } else {
      this.redistributeClients(sortedClients);
    }

    this.evaluateHighPriorityGroups();

    /**
     * Compute reason + score for each waiting client
     */
    this.evaluateWaitingClients(sortedClients.length);

    /**
     * Track join rate for estimated wait time
     */
    this.joinRateWindow.push(this.joinsSinceLastCycle);
    if (this.joinRateWindow.length > JOIN_RATE_WINDOW) {
      this.joinRateWindow.shift();
    }
    this.joinsSinceLastCycle = 0;

    /**
     * Expose queue-wide stats through the room listing
     * (queryable through `matchMaker.query()` / `matchMaker.getQueueStats()`)
     */
    this.publishQueueStats(sortedClients);

    this.processGroupsReady();
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
      // Sort by score (highest first), then by average rank ascending.
      // (the score of each team member has been computed on the previous cycle)
      const scoreDiff = this.getTeamScore(b) - this.getTeamScore(a);
      if (scoreDiff !== 0) { return scoreDiff; }
      return a.averageRank - b.averageRank;
    });

    /**
     * Teams that did not fit the remaining slots of a group on this cycle.
     * (they are skipped instead of being split across groups)
     */
    const skippedTeams = new Set<QueueMatchTeam>();

    // Iterate over teams multiple times until all clients are assigned to a group
    do {
      let currentGroup: QueueMatchGroup = this.createMatchGroup();
      teams = teams.filter((team) => {
        const chunkSize = Math.min(this.maxTeamSize, team.clients.length);

        //
        // Skip candidates whose team size does not fit the remaining slots of
        // the current group. (the team stays intact for the next group/cycle)
        //
        if (
          currentGroup.clients.length > 0 &&
          currentGroup.clients.length + chunkSize > this.maxPlayers
        ) {
          skippedTeams.add(team);
          return true;
        }

        // Remove clients from the team and add them to the current group
        const totalRank = team.averageRank * team.clients.length;

        // currentGroup.averageRank = (currentGroup.averageRank === undefined)
        //   ? team.averageRank
        //   : (currentGroup.averageRank + team.averageRank) / ;
        currentGroup = this.redistributeClients(team.clients.splice(0, this.maxTeamSize), currentGroup, totalRank);

        if (team.clients.length >= this.maxTeamSize) {
          // team still has enough clients to form a group
          return true;
        }

        // increment cycle count for all clients in the team
        team.clients.forEach((client) => client.userData.currentCycle++);

        return false;
      });
    } while (teams.length >= 2);

    //
    // Assign remaining teams (skipped, or last one standing) to their own
    // groups, so their clients are tracked and receive queue updates.
    //
    for (const team of teams) {
      const reason: QueueReason | undefined = (skippedTeams.has(team))
        ? QueueReason.TEAM_SIZE_MISMATCH
        : undefined;

      while (team.clients.length > 0) {
        const chunk = team.clients.splice(0, this.maxTeamSize);
        if (reason) {
          chunk.forEach((client) => client.userData.queueReason = reason);
        }
        this.redistributeClients(chunk, this.createMatchGroup(), team.averageRank * chunk.length);
      }
    }
  }

  redistributeClients(
    sortedClients: Client<{ userData: QueueClientData }>[],
    currentGroup: QueueMatchGroup = this.createMatchGroup(),
    totalRank: number = 0,
  ) {
    for (let i = 0, l = sortedClients.length; i < l; i++) {
      const client = sortedClients[i];
      const userData = client.userData;
      const currentCycle = userData.currentCycle++;

      if (currentGroup.averageRank > 0) {
        if (
          !this.compare(userData, currentGroup) &&
          !userData.highPriority
        ) {
          currentGroup = this.createMatchGroup();
          totalRank = 0;
        }
      }

      userData.group = currentGroup;

      // the first client of a group defines its region
      if (currentGroup.clients.length === 0) {
        currentGroup.region = userData.region;
      }

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

      } else if (
        this.maxWaitingCyclesForPriority !== undefined &&
        currentCycle >= this.maxWaitingCyclesForPriority
      ) {
        /**
         * Force this client to join a group, even if rank is incompatible
         */
        userData.highPriority = true;
      }
    }

    return currentGroup;
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

  /**
   * Compute the reason and the explainable score of each waiting client.
   */
  protected evaluateWaitingClients(waitingClientCount: number) {
    for (const group of this.groups) {
      if (group.ready) { continue; }

      for (const client of group.clients) {
        const userData = client.userData;
        if (!userData) { continue; }

        if (userData.queueReason !== QueueReason.TEAM_SIZE_MISMATCH) {
          //
          // the client is either waiting for more players, or there are other
          // clients waiting but none compatible with its group.
          //
          userData.queueReason = (
            waitingClientCount > group.clients.length &&
            group.clients.length < this.maxPlayers
          )
            ? QueueReason.WAITING_FOR_COMPATIBLE_GROUP
            : QueueReason.WAITING_FOR_PLAYERS;
        }

        userData.lastScore = this.computeScore(userData, group);
      }
    }
  }

  /**
   * Compute the explainable score of a client against a group.
   * (uses the custom `score` option when provided)
   */
  computeScore(userData: QueueClientData, group?: QueueMatchGroup): QueueScoreBreakdown {
    if (this.score) {
      const result = this.score(userData, group);

      return (typeof (result) === "number")
        ? { total: result, components: { wait: 0, rank: 0, region: 0 }, weights: this.scoreWeights }
        : result;
    }

    const weights = this.scoreWeights;

    //
    // wait: 0 → 1 as the client approaches the "high priority" threshold
    //
    const priorityCycles = this.maxWaitingCyclesForPriority ?? this.maxWaitingCycles;
    const wait = clamp01((userData.currentCycle ?? 0) / priorityCycles);

    //
    // rank: 1 when identical to the group's average, 0 at (and beyond) the
    // compatibility boundary used by the default `compare` (diffRatio of 2)
    //
    let rank = 1;
    if (
      group && group.clients.length > 0 &&
      group.averageRank > 0 &&
      typeof (userData.rank) === "number"
    ) {
      const diffRatio = Math.abs(userData.rank - group.averageRank) / group.averageRank;
      rank = clamp01(1 - diffRatio / 2);
    }

    //
    // region: 1 when the client shares the group's region (or no region
    // information is available), 0 otherwise
    //
    let region = 1;
    if (userData.region && group?.region && userData.region !== group.region) {
      region = 0;
    }

    const total =
      (wait * weights.wait) +
      (rank * weights.rank) +
      (region * weights.region);

    return { total, components: { wait, rank, region }, weights };
  }

  /**
   * Get the current queue status of a client: why it is still waiting, its
   * explainable score, and the estimated wait time.
   */
  getQueueStatus(client: Client<{ userData: QueueClientData }>): QueueClientStatus {
    const userData = client.userData;
    const group = userData?.group;
    const clients = group?.clients.length ?? 1;

    return {
      clients,
      needed: Math.max(0, this.maxPlayers - clients),
      reason: this.getQueueReason(client),
      estimatedWaitMs: this.estimateWaitMs(userData, group),
      score: userData?.lastScore ?? this.computeScore(userData ?? {} as QueueClientData, group),
    };
  }

  /**
   * Get the reason why a client is still waiting in the queue.
   */
  protected getQueueReason(client: Client<{ userData: QueueClientData }>): QueueReason {
    const userData = client.userData;

    if (userData?.group?.ready) {
      return QueueReason.AWAITING_CONFIRMATION;
    }

    return userData?.queueReason ?? QueueReason.WAITING_FOR_PLAYERS;
  }

  /**
   * Estimate how long (in milliseconds) until a client is matched, based on
   * the observed join rate of this queue. When `allowIncompleteGroups` is
   * enabled, the estimate never exceeds the cycles left until the group is
   * matched with bots. Returns `null` when there is not enough information.
   */
  protected estimateWaitMs(userData: QueueClientData | undefined, group?: QueueMatchGroup): number | null {
    const needed = this.maxPlayers - (group?.clients.length ?? 0);
    if (needed <= 0) { return 0; }

    let cycles: number | null = null;

    const joinRate = this.getAverageJoinRate();
    if (joinRate > 0) {
      cycles = needed / joinRate;
    }

    if (this.allowIncompleteGroups) {
      // worst case: matched with bots once `maxWaitingCycles` is reached
      const cyclesUntilBotFill = Math.max(0, this.maxWaitingCycles - (userData?.currentCycle ?? 0));
      cycles = (cycles === null)
        ? cyclesUntilBotFill
        : Math.min(cycles, cyclesUntilBotFill);
    }

    return (cycles === null)
      ? null
      : Math.round(cycles * this.cycleTickInterval);
  }

  /**
   * Average number of clients joining the queue per cycle.
   */
  protected getAverageJoinRate() {
    if (this.joinRateWindow.length === 0) { return 0; }
    return this.joinRateWindow.reduce((sum, joins) => sum + joins, 0) / this.joinRateWindow.length;
  }

  /**
   * Aggregate score of a team (average of its members' last computed score).
   */
  protected getTeamScore(team: QueueMatchTeam) {
    let total = 0;
    for (const client of team.clients) {
      total += client.userData?.lastScore?.total ?? 0;
    }
    return total / team.clients.length;
  }

  /**
   * Evaluate "ready" groups waiting for confirmation. Releases the seats of
   * groups that have been waiting for confirmation for too long, so seats
   * are never held indefinitely by clients that never confirm.
   */
  protected evaluatePendingConfirmations() {
    for (let i = this.pendingConfirmation.length - 1; i >= 0; i--) {
      const group = this.pendingConfirmation[i];

      // all clients confirmed - nothing left to do.
      if ((group.confirmed ?? 0) >= group.clients.length) {
        this.pendingConfirmation.splice(i, 1);
        continue;
      }

      // still within the confirmation window.
      if (!group.reservation || (this.cycleCount - group.reservation.cycle) < this.maxConfirmationCycles) {
        continue;
      }

      //
      // confirmation timed out: release pending seats and re-queue (or drop)
      // the clients that never confirmed.
      //
      this.pendingConfirmation.splice(i, 1);
      this.releaseGroupSeats(group);

      debugMatchMaking("QueueRoom: confirmation timed out for group of %d clients (%d confirmed)", group.clients.length, group.confirmed ?? 0);

      for (const client of group.clients) {
        const userData = client.userData;
        if (!userData || userData.confirmed) { continue; }

        userData.confirmed = false;
        userData.group = undefined;
        userData.reservationRetries = (userData.reservationRetries ?? 0) + 1;

        if (userData.reservationRetries > this.maxReservationRetries) {
          client.leave(1011, "seat reservation confirmation timed out");
        }
      }
    }
  }

  /**
   * Release every pending (unconfirmed) seat reservation of a group.
   */
  protected releaseGroupSeats(group: QueueMatchGroup) {
    if (!group.reservation) { return; }

    const pendingSessionIds = group.clients
      .filter((client) => !client.userData?.confirmed)
      .map((client) => client.sessionId);

    if (pendingSessionIds.length > 0) {
      matchMaker.releaseMultipleSeatsFor(group.reservation.room, pendingSessionIds)
        .catch((e) => debugMatchMaking("QueueRoom: failed to release seats: %s", e?.message ?? e));
    }

    group.reservation = undefined;
  }

  /**
   * Roll back a failed group reservation: release any seats that may have
   * been reserved, dispose the created room (optional), and re-queue (or
   * drop) the clients.
   */
  protected async rollbackGroupReservation(group: QueueMatchGroup, room: IRoomCache | undefined, error: any) {
    debugMatchMaking("QueueRoom: group reservation failed (%s), rolling back.", error?.message ?? error);

    if (room) {
      const sessionIds = group.clients.map((client) => client.sessionId);

      try {
        await matchMaker.releaseMultipleSeatsFor(room, sessionIds);
      } catch (e: any) {
        debugMatchMaking("QueueRoom: failed to release seats during rollback: %s", e?.message ?? e);
      }

      if (this.rollbackCreatedRoom) {
        // fire-and-forget: the room may already be disposed by now.
        matchMaker.remoteRoomCall<Room>(room.roomId, 'disconnect').catch(() => { });
      }
    }

    group.clients.forEach((client) => {
      const userData = client.userData;
      if (!userData) { return; }

      userData.confirmed = false;
      userData.group = undefined;
      userData.reservationRetries = (userData.reservationRetries ?? 0) + 1;

      if (userData.reservationRetries > this.maxReservationRetries) {
        client.leave(1011, error?.message ?? "seat reservation failed");
      }
    });
  }

  /**
   * Publish queue-wide stats on the room's metadata, so callers can query
   * the current state of the queue through the MatchMaker.
   */
  protected publishQueueStats(waitingClients: Array<Client<{ userData: QueueClientData }>>) {
    // room is not fully created yet (e.g. unit tests)
    if (!this.roomId) { return; }

    const count = waitingClients.length;

    let totalCycles = 0;
    let totalEstimatedWaitMs = 0;
    let estimatedWaitCount = 0;

    for (const client of waitingClients) {
      const userData = client.userData;
      totalCycles += userData?.currentCycle ?? 0;

      const estimatedWaitMs = this.estimateWaitMs(userData, userData?.group);
      if (estimatedWaitMs !== null) {
        totalEstimatedWaitMs += estimatedWaitMs;
        estimatedWaitCount++;
      }
    }

    const stats: QueueRoomStats = {
      clients: count,
      groups: this.groups.filter((group) => !group.ready && group.clients.length > 0).length,
      averageWaitCycles: (count > 0) ? totalCycles / count : 0,
      estimatedWaitMs: (estimatedWaitCount > 0) ? Math.round(totalEstimatedWaitMs / estimatedWaitCount) : null,
      updatedAt: Date.now(),
    };

    // avoid persisting metadata when nothing relevant changed
    const { updatedAt, ...comparable } = stats;
    const serialized = JSON.stringify(comparable);
    if (serialized === this.lastPublishedStats) { return; }
    this.lastPublishedStats = serialized;

    this.setMetadata({ ...(this.metadata ?? {}), queue: stats })
      .catch((e) => debugMatchMaking("QueueRoom: failed to publish queue stats: %s", e?.message ?? e));
  }

  processGroupsReady() {
    this.groups.forEach(async (group) => {
      if (group.ready) {
        group.confirmed = 0;

        let room: IRoomCache | undefined;

        try {
          /**
           * Create room instance in the server.
           */
          room = await this.onGroupReady.call(this, group);

          /**
           * Reserve a seat for each client in the group.
           * (If one fails, force all clients to leave, re-queueing is up to the client-side logic)
           */
          await matchMaker.reserveMultipleSeatsFor(
            room,
            group.clients.map((client) => ({
              sessionId: client.sessionId,
              options: client.userData.options,
              auth: client.auth,
            })),
          );

          /**
           * Track the reservation, so seats can be released if clients
           * never confirm.
           */
          group.reservation = { room, cycle: this.cycleCount };
          this.pendingConfirmation.push(group);

          /**
           * Send room data for new WebSocket connection!
           */
          group.clients.forEach((client, i) => {
            client.send("seat", matchMaker.buildSeatReservation(room, client.sessionId));
          });

        } catch (e: any) {
          //
          // If creating a room, or reserving a seat failed - release any
          // reserved seats, dispose the created room, and re-queue clients.
          // (clients are dropped after `maxReservationRetries` failures)
          //
          await this.rollbackGroupReservation(group, room, e);
        }

      } else {
        /**
         * Notify clients within the group on how many players are in the queue
         */
        group.clients.forEach((client) => {
          //
          // avoid sending the same number of clients to the client if it hasn't changed
          //
          const queueClientCount = group.clients.length;
          if (client.userData.lastQueueClientCount !== queueClientCount) {
            client.userData.lastQueueClientCount = queueClientCount;
            client.send("clients", queueClientCount);
          }

          /**
           * Send the full queue status (reason, score, estimated wait)
           */
          client.send("queue", this.getQueueStatus(client));
        });
      }
    });
  }

}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}
