import type { Connection } from "@libp2p/interface-connection";
import type { ConnectionManager } from "@libp2p/interface-connection-manager";
import type { PeerId } from "@libp2p/interface-peer-id";
import type { Peer, PeerStore } from "@libp2p/interface-peer-store";
import { sha256 } from "@noble/hashes/sha256";
import { concat, utf8ToBytes } from "@waku/byte-utils";
import {
  Cursor,
  IDecodedMessage,
  IDecoder,
  Index,
  IStore,
} from "@waku/interfaces";
import {
  getPeersForProtocol,
  selectConnection,
  selectPeerForProtocol,
} from "@waku/libp2p-utils";
import { proto_store as proto } from "@waku/proto";
import debug from "debug";
import all from "it-all";
import * as lp from "it-length-prefixed";
import { pipe } from "it-pipe";
import { Uint8ArrayList } from "uint8arraylist";

import { DefaultPubSubTopic } from "../constants.js";
import { toProtoMessage } from "../to_proto_message.js";

import { HistoryRPC, PageDirection, Params } from "./history_rpc.js";

import HistoryError = proto.HistoryResponse.HistoryError;

const log = debug("waku:store");

export const StoreCodec = "/vac/waku/store/2.0.0-beta4";

export const DefaultPageSize = 10;

export { PageDirection };

export interface StoreComponents {
  peerStore: PeerStore;
  connectionManager: ConnectionManager;
}

export interface CreateOptions {
  /**
   * The PubSub Topic to use. Defaults to {@link DefaultPubSubTopic}.
   *
   * The usage of the default pubsub topic is recommended.
   * See [Waku v2 Topic Usage Recommendations](https://rfc.vac.dev/spec/23/) for details.
   *
   * @default {@link DefaultPubSubTopic}
   */
  pubSubTopic?: string;
}

export interface TimeFilter {
  startTime: Date;
  endTime: Date;
}

export interface QueryOptions {
  /**
   * The peer to query. If undefined, a pseudo-random peer is selected from the connected Waku Store peers.
   */
  peerId?: PeerId;
  /**
   * The pubsub topic to pass to the query.
   * See [Waku v2 Topic Usage Recommendations](https://rfc.vac.dev/spec/23/).
   */
  pubSubTopic?: string;
  /**
   * The direction in which pages are retrieved:
   * - { @link PageDirection.BACKWARD }: Most recent page first.
   * - { @link PageDirection.FORWARD }: Oldest page first.
   *
   * Note: This does not affect the ordering of messages with the page
   * (the oldest message is always first).
   *
   * @default { @link PageDirection.BACKWARD }
   */
  pageDirection?: PageDirection;
  /**
   * The number of message per page.
   *
   * @default { @link DefaultPageSize }
   */
  pageSize?: number;
  /**
   * Retrieve messages with a timestamp within the provided values.
   */
  timeFilter?: TimeFilter;
  /**
   * Cursor as an index to start a query from.
   * The cursor index will be exclusive (i.e. the message at the cursor index will not be included in the result).
   * If undefined, the query will start from the beginning or end of the history, depending on the page direction.
   */
  cursor?: Cursor;
}

/**
 * Implements the [Waku v2 Store protocol](https://rfc.vac.dev/spec/13/).
 *
 * The Waku Store protocol can be used to retrieved historical messages.
 */
class Store implements IStore {
  pubSubTopic: string;

  constructor(public components: StoreComponents, options?: CreateOptions) {
    this.pubSubTopic = options?.pubSubTopic ?? DefaultPubSubTopic;
  }

  /**
   * Do a query to a Waku Store to retrieve historical/missed messages.
   *
   * The callback function takes a `WakuMessage` in input,
   * messages are processed in order:
   * - oldest to latest if `options.pageDirection` == { @link PageDirection.FORWARD }
   * - latest to oldest if `options.pageDirection` == { @link PageDirection.BACKWARD }
   *
   * The ordering may affect performance.
   * The ordering depends on the behavior of the remote store node.
   * If strong ordering is needed, you may need to handle this at application level
   * and set your own timestamps too (the WakuMessage timestamps are not certified).
   *
   * @throws If not able to reach a Waku Store peer to query,
   * or if an error is encountered when processing the reply,
   * or if two decoders with the same content topic are passed.
   */
  async queryOrderedCallback<T extends IDecodedMessage>(
    decoders: IDecoder<T>[],
    callback: (message: T) => Promise<void | boolean> | boolean | void,
    options?: QueryOptions
  ): Promise<void> {
    let abort = false;
    for await (const promises of this.queryGenerator(decoders, options)) {
      if (abort) break;
      const messagesOrUndef: Array<T | undefined> = await Promise.all(promises);

      let messages: Array<T> = messagesOrUndef.filter(isDefined);

      // Messages in pages are ordered from oldest (first) to most recent (last).
      // https://github.com/vacp2p/rfc/issues/533
      if (
        typeof options?.pageDirection === "undefined" ||
        options?.pageDirection === PageDirection.BACKWARD
      ) {
        messages = messages.reverse();
      }

      await Promise.all(
        messages.map(async (msg) => {
          if (msg && !abort) {
            abort = Boolean(await callback(msg));
          }
        })
      );
    }
  }

  /**
   * Do a query to a Waku Store to retrieve historical/missed messages.
   *
   * The callback function takes a `Promise<WakuMessage>` in input,
   * useful if messages needs to be decrypted and performance matters.
   *
   * The order of the messages passed to the callback is as follows:
   * - within a page, messages are expected to be ordered from oldest to most recent
   * - pages direction depends on { @link QueryOptions.pageDirection }
   *
   * Do note that the resolution of the `Promise<WakuMessage | undefined` may
   * break the order as it may rely on the browser decryption API, which in turn,
   * may have a different speed depending on the type of decryption.
   *
   * @throws If not able to reach a Waku Store peer to query,
   * or if an error is encountered when processing the reply,
   * or if two decoders with the same content topic are passed.
   */
  async queryCallbackOnPromise<T extends IDecodedMessage>(
    decoders: IDecoder<T>[],
    callback: (
      message: Promise<T | undefined>
    ) => Promise<void | boolean> | boolean | void,
    options?: QueryOptions
  ): Promise<void> {
    let abort = false;
    let promises: Promise<void>[] = [];
    for await (const page of this.queryGenerator(decoders, options)) {
      const _promises = page.map(async (msg) => {
        if (!abort) {
          abort = Boolean(await callback(msg));
        }
      });

      promises = promises.concat(_promises);
    }
    await Promise.all(promises);
  }

  /**
   * Do a query to a Waku Store to retrieve historical/missed messages.
   *
   * This is a generator, useful if you want most control on how messages
   * are processed.
   *
   * The order of the messages returned by the remote Waku node SHOULD BE
   * as follows:
   * - within a page, messages SHOULD be ordered from oldest to most recent
   * - pages direction depends on { @link QueryOptions.pageDirection }
   *
   * However, there is no way to guarantee the behavior of the remote node.
   *
   * @throws If not able to reach a Waku Store peer to query,
   * or if an error is encountered when processing the reply,
   * or if two decoders with the same content topic are passed.
   */
  async *queryGenerator<T extends IDecodedMessage>(
    decoders: IDecoder<T>[],
    options?: QueryOptions
  ): AsyncGenerator<Promise<T | undefined>[]> {
    let startTime, endTime;

    if (options?.timeFilter) {
      startTime = options.timeFilter.startTime;
      endTime = options.timeFilter.endTime;
    }

    const decodersAsMap = new Map();
    decoders.forEach((dec) => {
      if (decodersAsMap.has(dec.contentTopic)) {
        throw new Error(
          "API does not support different decoder per content topic"
        );
      }
      decodersAsMap.set(dec.contentTopic, dec);
    });

    const contentTopics = decoders.map((dec) => dec.contentTopic);

    const queryOpts = Object.assign(
      {
        pubSubTopic: this.pubSubTopic,
        pageDirection: PageDirection.BACKWARD,
        pageSize: DefaultPageSize,
      },
      options,
      { contentTopics, startTime, endTime }
    );

    log("Querying history with the following options", {
      ...options,
      peerId: options?.peerId?.toString(),
    });

    const res = await selectPeerForProtocol(
      this.components.peerStore,
      [StoreCodec],
      options?.peerId
    );

    if (!res) {
      throw new Error("Failed to get a peer");
    }
    const { peer, protocol } = res;

    const connections = this.components.connectionManager.getConnections(
      peer.id
    );
    const connection = selectConnection(connections);

    if (!connection) throw "Failed to get a connection to the peer";

    for await (const messages of paginate<T>(
      connection,
      protocol,
      queryOpts,
      decodersAsMap,
      options?.cursor
    )) {
      yield messages;
    }
  }

  /**
   * Returns known peers from the address book (`libp2p.peerStore`) that support
   * store protocol. Waku may or  may not be currently connected to these peers.
   */
  async peers(): Promise<Peer[]> {
    return getPeersForProtocol(this.components.peerStore, [StoreCodec]);
  }

  get peerStore(): PeerStore {
    return this.components.peerStore;
  }
}

async function* paginate<T extends IDecodedMessage>(
  connection: Connection,
  protocol: string,
  queryOpts: Params,
  decoders: Map<string, IDecoder<T>>,
  cursor?: Cursor
): AsyncGenerator<Promise<T | undefined>[]> {
  if (
    queryOpts.contentTopics.toString() !==
    Array.from(decoders.keys()).toString()
  ) {
    throw new Error(
      "Internal error, the decoders should match the query's content topics"
    );
  }

  let currentCursor = cursor;
  while (true) {
    queryOpts.cursor = currentCursor;

    const stream = await connection.newStream(protocol);
    const historyRpcQuery = HistoryRPC.createQuery(queryOpts);

    log(
      "Querying store peer",
      connection.remoteAddr.toString(),
      `for (${queryOpts.pubSubTopic})`,
      queryOpts.contentTopics
    );

    const res = await pipe(
      [historyRpcQuery.encode()],
      lp.encode(),
      stream,
      lp.decode(),
      async (source) => await all(source)
    );

    const bytes = new Uint8ArrayList();
    res.forEach((chunk) => {
      bytes.append(chunk);
    });

    const reply = historyRpcQuery.decode(bytes);

    if (!reply.response) {
      log("Stopping pagination due to store `response` field missing");
      break;
    }

    const response = reply.response as proto.HistoryResponse;

    if (
      response.error &&
      response.error !== HistoryError.ERROR_NONE_UNSPECIFIED
    ) {
      throw "History response contains an Error: " + response.error;
    }

    if (!response.messages || !response.messages.length) {
      log(
        "Stopping pagination due to store `response.messages` field missing or empty"
      );
      break;
    }

    log(`${response.messages.length} messages retrieved from store`);

    yield response.messages.map((protoMsg) => {
      const contentTopic = protoMsg.contentTopic;
      if (typeof contentTopic !== "undefined") {
        const decoder = decoders.get(contentTopic);
        if (decoder) {
          return decoder.fromProtoObj(toProtoMessage(protoMsg));
        }
      }
      return Promise.resolve(undefined);
    });

    const nextCursor = response.pagingInfo?.cursor;
    if (typeof nextCursor === "undefined") {
      // If the server does not return cursor then there is an issue,
      // Need to abort, or we end up in an infinite loop
      log(
        "Stopping pagination due to `response.pagingInfo.cursor` missing from store response"
      );
      break;
    }

    currentCursor = nextCursor;

    const responsePageSize = response.pagingInfo?.pageSize;
    const queryPageSize = historyRpcQuery.query?.pagingInfo?.pageSize;
    if (
      // Response page size smaller than query, meaning this is the last page
      responsePageSize &&
      queryPageSize &&
      responsePageSize < queryPageSize
    ) {
      break;
    }
  }
}

export function isDefined<T>(msg: T | undefined): msg is T {
  return !!msg;
}

export async function createCursor(
  message: IDecodedMessage,
  pubsubTopic: string = DefaultPubSubTopic
): Promise<Index> {
  if (
    !message ||
    !message.timestamp ||
    !message.payload ||
    !message.contentTopic
  ) {
    throw new Error("Message is missing required fields");
  }

  const contentTopicBytes = utf8ToBytes(message.contentTopic);

  const digest = sha256(concat([contentTopicBytes, message.payload]));

  const messageTime = BigInt(message.timestamp.getTime()) * BigInt(1000000);

  return {
    digest,
    pubsubTopic,
    senderTime: messageTime,
    receivedTime: messageTime,
  };
}

export function wakuStore(
  init: Partial<CreateOptions> = {}
): (components: StoreComponents) => IStore {
  return (components: StoreComponents) => new Store(components, init);
}
