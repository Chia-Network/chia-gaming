import type { Pair } from '../util/Pair';

type PairCallback = (pairs: Pair[]) => Pair[];

export type Pairs = {
  addPair: (pair: Pair) => void;
  getPair: (topic: string) => Pair | undefined;
  updatePair: (
    topic: string,
    pair: Partial<Pair> | ((pair: Pair) => Pair),
  ) => void;
  removePair: (topic: string) => void;
  hasPair: (topic: string) => boolean;

  get: () => Pair[];

  getPairBySession: (sessionTopic: string) => Pair | undefined;
  removePairBySession: (sessionTopic: string) => void;

  removeSessionFromPair: (sessionTopic: string) => void;

  bypassCommand: (
    sessionTopic: string,
    command: string,
    confirm: boolean,
  ) => void;
  bypassCommands: (
    sessionTopic: string,
    commands: string[],
    confirm: boolean,
  ) => void;
  removeBypassCommand: (sessionTopic: string, command: string) => void;
  resetBypassForAllPairs: () => void;
  resetBypassForPair: (pairTopic: string) => void;
};

type PairFn = (pairs: Pair[]) => Pair[];

export function parseWcLink(
  wc_link: string,
  fingerprints: number[],
): any | null {
  const wc_index = wc_link.indexOf(':');
  if (wc_index < 0) {
    return null;
  }
  const after_colon = wc_link.slice(wc_index + 1);
  const at_two = after_colon.indexOf('@2');
  if (at_two < 0) {
    return null;
  }
  const topic = after_colon.slice(0, at_two);
  const q_index = after_colon.indexOf('?');
  const query_part = after_colon.slice(q_index + 1);

  return {
    uri: wc_link,
    topic: topic,
    fingerprints: fingerprints,
    mainnet: true,
    sessions: [],
  };
}

export function useWalletConnectPairs(): Pairs {
  let pairsRef: Pair[] = [];
  function setPairs(computeNew: PairFn) {
    pairsRef = computeNew(pairsRef);
  }

  const updatePair = (
    topic: string,
    data: Partial<Omit<Pair, 'topic'>> | ((pair: Pair) => Pair),
  ) => {
    setPairs((pairs: Pair[]) => {
      const index = pairs.findIndex((item) => item.topic === topic);
      if (index === -1) {
        return pairs;
      }

      const oldPair = pairs[index];
      const newPairing =
        typeof data === 'function' ? data(oldPair) : { ...oldPair, ...data };
      const newPairings = [...pairs];
      newPairings[index] = newPairing;

      return newPairings;
    });
  };

  const removePair = (topic: string) => {
    setPairs((pairs: Pair[]) => pairs.filter((item) => item.topic !== topic));
  };

  const removePairBySession = (sessionTopic: string) => {
    setPairs((pairs: Pair[]) =>
      pairs.filter(
        (item) =>
          !item.sessions.find((session) => session.topic === sessionTopic),
      ),
    );
  };

  const getPair = (topic: string) => {
    return pairsRef.find((item) => item.topic === topic);
  };

  const hasPair = (topic: string) => {
    return !!pairsRef.find((item) => item.topic === topic);
  };

  const getPairBySession = (sessionTopic: string) => {
    return pairsRef.find((item) =>
      item.sessions?.find((session) => session.topic === sessionTopic),
    );
  };

  const addPair = (pair: Pair) => {
    setPairs((pairs: Pair[]) => {
      const index = pairs.findIndex((item) => item.topic === pair.topic);
      if (index !== -1) {
        throw new Error('Pair already exists');
      }

      return [...pairs, pair];
    });
  };

  const removeSessionFromPair = (sessionTopic: string) => {
    setPairs((pairs: Pair[]) =>
      pairs.map((pair) => ({
        ...pair,
        sessions: pair.sessions.filter((item) => item.topic !== sessionTopic),
      })),
    );
  };

  const get = () => pairsRef;

  const bypassCommand = (
    sessionTopic: string,
    command: string,
    confirm: boolean,
  ) => {
    setPairs((pairs: Pair[]) => {
      const pair = pairs.find((item) =>
        item.sessions?.find((session) => session.topic === sessionTopic),
      );
      if (!pair) {
        throw new Error('Pair not found');
      }

      return pairs.map((item) => ({
        ...item,
        bypassCommands:
          item.topic === pair.topic
            ? {
                ...item.bypassCommands,
                [command]: confirm,
              }
            : item.bypassCommands,
      }));
    });
  };

  const bypassCommands = (
    sessionTopic: string,
    commands: string[],
    confirm: boolean,
  ) => {
    setPairs((pairs: Pair[]) => {
      const pair = pairs.find((item) =>
        item.sessions?.find((session) => session.topic === sessionTopic),
      );
      if (!pair) {
        throw new Error('Pair not found');
      }

      return pairs.map((item) => ({
        ...item,
        bypassCommands:
          item.topic === pair.topic
            ? {
                ...item.bypassCommands,
                ...commands.reduce(
                  (acc, command) => ({ ...acc, [command]: confirm }),
                  {},
                ),
              }
            : item.bypassCommands,
      }));
    });
  };

  const removeBypassCommand = (sessionTopic: string, command: string) => {
    const deleteCommand = (commands: Record<string, boolean> | undefined) => {
      const newBypassCommands = { ...commands };
      delete newBypassCommands[command];
      return newBypassCommands;
    };

    setPairs((pairs: Pair[]) => {
      const pair = pairs.find((item) =>
        item.sessions?.find((session) => session.topic === sessionTopic),
      );
      if (!pair) {
        throw new Error('Pair not found');
      }

      return pairs.map((item) => ({
        ...item,
        bypassCommands:
          item.topic === pair.topic && command in (item.bypassCommands ?? {})
            ? deleteCommand(item.bypassCommands)
            : item.bypassCommands,
      }));
    });
  };

  const resetBypassForAllPairs = () => {
    setPairs((pairs: Pair[]) =>
      pairs.map((item) => ({
        ...item,
        bypassCommands: {},
      })),
    );
  };

  const resetBypassForPair = (pairTopic: string) => {
    setPairs((pairs: Pair[]) =>
      pairs.map((item) => ({
        ...item,
        bypassCommands:
          item.topic === pairTopic
            ? {} // reset bypass commands
            : item.bypassCommands,
      })),
    );
  };

  return {
    addPair,
    getPair,
    updatePair,
    removePair,
    hasPair,

    get,

    getPairBySession,
    removePairBySession,

    removeSessionFromPair,
    bypassCommand,
    bypassCommands,
    removeBypassCommand,
    resetBypassForAllPairs,
    resetBypassForPair,
  };
}
