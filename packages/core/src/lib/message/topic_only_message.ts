import type {
  IDecodedMessage,
  IDecoder,
  IProtoMessage,
} from "@waku/interfaces";
import { proto_topic_only_message as proto } from "@waku/proto";
import debug from "debug";

const log = debug("waku:message:topic-only");

export class TopicOnlyMessage implements IDecodedMessage {
  public payload: undefined;
  public rateLimitProof: undefined;
  public timestamp: undefined;
  public ephemeral: undefined;

  constructor(private proto: proto.TopicOnlyMessage) {}

  get contentTopic(): string {
    return this.proto.contentTopic ?? "";
  }
}

export class TopicOnlyDecoder implements IDecoder<TopicOnlyMessage> {
  public contentTopic = "";

  fromWireToProtoObj(bytes: Uint8Array): Promise<IProtoMessage | undefined> {
    const protoMessage = proto.TopicOnlyMessage.decode(bytes);
    log("Message decoded", protoMessage);
    return Promise.resolve({
      contentTopic: protoMessage.contentTopic,
      payload: undefined,
      rateLimitProof: undefined,
      timestamp: undefined,
      version: undefined,
      ephemeral: undefined,
    });
  }

  async fromProtoObj(
    proto: IProtoMessage
  ): Promise<TopicOnlyMessage | undefined> {
    return new TopicOnlyMessage(proto);
  }
}