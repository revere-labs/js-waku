import { expect } from "chai";
import fc from "fast-check";

import { createDecoder, createEncoder, DecodedMessage } from "./version_0.js";

const TestContentTopic = "/test/1/waku-message/utf8";

describe("Waku Message version 0", function () {
  it("Round trip binary serialization", async function () {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 1 }), async (payload) => {
        const encoder = createEncoder(TestContentTopic);
        const bytes = await encoder.toWire({ payload });
        const decoder = createDecoder(TestContentTopic);
        const protoResult = await decoder.fromWireToProtoObj(bytes);
        const result = (await decoder.fromProtoObj(
          protoResult!
        )) as DecodedMessage;

        expect(result.contentTopic).to.eq(TestContentTopic);
        expect(result.version).to.eq(0);
        expect(result.ephemeral).to.be.false;
        expect(result.payload).to.deep.eq(payload);
        expect(result.timestamp).to.not.be.undefined;
      })
    );
  });

  it("Ephemeral field set to true", async function () {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 1 }), async (payload) => {
        const encoder = createEncoder(TestContentTopic, true);
        const bytes = await encoder.toWire({ payload });
        const decoder = createDecoder(TestContentTopic);
        const protoResult = await decoder.fromWireToProtoObj(bytes);
        const result = (await decoder.fromProtoObj(
          protoResult!
        )) as DecodedMessage;

        expect(result.contentTopic).to.eq(TestContentTopic);
        expect(result.version).to.eq(0);
        expect(result.ephemeral).to.be.true;
        expect(result.payload).to.deep.eq(payload);
        expect(result.timestamp).to.not.be.undefined;
      })
    );
  });
});
