import { bytesToUtf8, utf8ToBytes } from "@waku/byte-utils";
import { waitForRemotePeer } from "@waku/core/lib/wait_for_remote_peer";
import { DecoderV0, EncoderV0 } from "@waku/core/lib/waku_message/version_0";
import { createFullNode, createLightNode } from "@waku/create";
import { DecodedMessage, Protocols, WakuLight } from "@waku/interfaces";
import {
  AsymDecoder,
  AsymEncoder,
  generatePrivateKey,
  generateSymmetricKey,
  getPublicKey,
  SymDecoder,
  SymEncoder,
} from "@waku/message-encryption";
import { expect } from "chai";
import debug from "debug";

import { makeLogFileName, NOISE_KEY_1, NOISE_KEY_2, Nwaku } from "../src";
import { delay } from "../src/delay";

const log = debug("waku:test:ephemeral");

const TestContentTopic = "/test/1/ephemeral/utf8";
const TestEncoder = new EncoderV0(TestContentTopic);
const TestDecoder = new DecoderV0(TestContentTopic);

describe("Waku Message Ephemeral field", () => {
  let waku: WakuLight;
  let nwaku: Nwaku;

  afterEach(async function () {
    !!nwaku && nwaku.stop();
    !!waku && waku.stop().catch((e) => console.log("Waku failed to stop", e));
  });

  beforeEach(async function () {
    this.timeout(15000);
    nwaku = new Nwaku(makeLogFileName(this));
    await nwaku.start({ filter: true, lightpush: true, store: true });
    waku = await createLightNode({
      staticNoiseKey: NOISE_KEY_1,
      libp2p: { addresses: { listen: ["/ip4/0.0.0.0/tcp/0/ws"] } },
    });
    await waku.start();
    await waku.dial(await nwaku.getMultiaddrWithId());
    await waitForRemotePeer(waku);
  });

  it("Ephemeral messages are not stored", async function () {
    this.timeout(15_000);

    const asymText =
      "This message is encrypted for me using asymmetric encryption";
    const symText =
      "This message is encrypted for me using symmetric encryption";
    const clearText = "This is a clear text message";

    const asymMsg = { payload: utf8ToBytes(asymText) };
    const symMsg = {
      payload: utf8ToBytes(symText),
    };
    const clearMsg = {
      payload: utf8ToBytes(clearText),
    };

    const privateKey = generatePrivateKey();
    const symKey = generateSymmetricKey();
    const publicKey = getPublicKey(privateKey);

    const AsymContentTopic = "/test/1/ephemeral-asym/utf8";
    const SymContentTopic = "/test/1/ephemeral-sym/utf8";

    const asymEncoder = new AsymEncoder(
      AsymContentTopic,
      publicKey,
      undefined,
      true
    );
    const symEncoder = new SymEncoder(SymContentTopic, symKey, undefined, true);
    const clearEncoder = new EncoderV0(TestContentTopic, true);

    const asymDecoder = new AsymDecoder(AsymContentTopic, privateKey);
    const symDecoder = new SymDecoder(SymContentTopic, symKey);

    const [waku1, waku2, nimWakuMultiaddr] = await Promise.all([
      createFullNode({
        staticNoiseKey: NOISE_KEY_1,
      }).then((waku) => waku.start().then(() => waku)),
      createFullNode({
        staticNoiseKey: NOISE_KEY_2,
      }).then((waku) => waku.start().then(() => waku)),
      nwaku.getMultiaddrWithId(),
    ]);

    log("Waku nodes created");

    await Promise.all([
      waku1.dial(nimWakuMultiaddr),
      waku2.dial(nimWakuMultiaddr),
    ]);

    log("Waku nodes connected to nwaku");

    await waitForRemotePeer(waku1, [Protocols.LightPush]);

    log("Sending messages using light push");
    await Promise.all([
      waku1.lightPush.push(asymEncoder, asymMsg),
      waku1.lightPush.push(symEncoder, symMsg),
      waku1.lightPush.push(clearEncoder, clearMsg),
    ]);

    await waitForRemotePeer(waku2, [Protocols.Store]);

    const messages: DecodedMessage[] = [];
    log("Retrieve messages from store");

    for await (const msgPromises of waku2.store.queryGenerator([
      asymDecoder,
      symDecoder,
      TestDecoder,
    ])) {
      for (const promise of msgPromises) {
        const msg = await promise;
        if (msg) {
          messages.push(msg);
        }
      }
    }

    expect(messages?.length).eq(0);

    !!waku1 && waku1.stop().catch((e) => console.log("Waku failed to stop", e));
    !!waku2 && waku2.stop().catch((e) => console.log("Waku failed to stop", e));
  });

  it("Ephemeral field is preserved - encoder v0", async function () {
    this.timeout(10000);

    const ephemeralEncoder = new EncoderV0(TestContentTopic, true);

    const messages: DecodedMessage[] = [];
    const callback = (msg: DecodedMessage): void => {
      messages.push(msg);
    };
    await waku.filter.subscribe([TestDecoder], callback);

    await delay(200);
    const normalTxt = "Normal message";
    const ephemeralTxt = "Ephemeral Message";
    await waku.lightPush.push(TestEncoder, {
      payload: utf8ToBytes(normalTxt),
    });
    await waku.lightPush.push(ephemeralEncoder, {
      payload: utf8ToBytes(ephemeralTxt),
    });
    while (messages.length < 2) {
      await delay(250);
    }

    const normalMsg = messages.find(
      (msg) => bytesToUtf8(msg.payload!) === normalTxt
    );
    const ephemeralMsg = messages.find(
      (msg) => bytesToUtf8(msg.payload!) === ephemeralTxt
    );

    expect(normalMsg).to.not.be.undefined;
    expect(ephemeralMsg).to.not.be.undefined;

    expect(normalMsg!.ephemeral).to.be.false;
    expect(ephemeralMsg!.ephemeral).to.be.true;
  });

  it("Ephemeral field is preserved - symmetric encryption", async function () {
    this.timeout(10000);

    const symKey = generateSymmetricKey();

    const ephemeralEncoder = new SymEncoder(
      TestContentTopic,
      symKey,
      undefined,
      true
    );
    const encoder = new SymEncoder(TestContentTopic, symKey);
    const decoder = new SymDecoder(TestContentTopic, symKey);

    const messages: DecodedMessage[] = [];
    const callback = (msg: DecodedMessage): void => {
      messages.push(msg);
    };
    await waku.filter.subscribe([decoder], callback);

    await delay(200);
    const normalTxt = "Normal message";
    const ephemeralTxt = "Ephemeral Message";
    await waku.lightPush.push(encoder, {
      payload: utf8ToBytes(normalTxt),
    });
    await waku.lightPush.push(ephemeralEncoder, {
      payload: utf8ToBytes(ephemeralTxt),
    });
    while (messages.length < 2) {
      await delay(250);
    }

    const normalMsg = messages.find(
      (msg) => bytesToUtf8(msg.payload!) === normalTxt
    );
    const ephemeralMsg = messages.find(
      (msg) => bytesToUtf8(msg.payload!) === ephemeralTxt
    );

    expect(normalMsg).to.not.be.undefined;
    expect(ephemeralMsg).to.not.be.undefined;

    expect(normalMsg!.ephemeral).to.be.false;
    expect(ephemeralMsg!.ephemeral).to.be.true;
  });

  it("Ephemeral field is preserved - asymmetric encryption", async function () {
    this.timeout(10000);

    const privKey = generatePrivateKey();
    const pubKey = getPublicKey(privKey);

    const ephemeralEncoder = new AsymEncoder(
      TestContentTopic,
      pubKey,
      undefined,
      true
    );
    const encoder = new AsymEncoder(TestContentTopic, pubKey);
    const decoder = new AsymDecoder(TestContentTopic, privKey);

    const messages: DecodedMessage[] = [];
    const callback = (msg: DecodedMessage): void => {
      messages.push(msg);
    };
    await waku.filter.subscribe([decoder], callback);

    await delay(200);
    const normalTxt = "Normal message";
    const ephemeralTxt = "Ephemeral Message";
    await waku.lightPush.push(encoder, {
      payload: utf8ToBytes(normalTxt),
    });
    await waku.lightPush.push(ephemeralEncoder, {
      payload: utf8ToBytes(ephemeralTxt),
    });
    while (messages.length < 2) {
      await delay(250);
    }

    const normalMsg = messages.find(
      (msg) => bytesToUtf8(msg.payload!) === normalTxt
    );
    const ephemeralMsg = messages.find(
      (msg) => bytesToUtf8(msg.payload!) === ephemeralTxt
    );

    expect(normalMsg).to.not.be.undefined;
    expect(ephemeralMsg).to.not.be.undefined;

    expect(normalMsg!.ephemeral).to.be.false;
    expect(ephemeralMsg!.ephemeral).to.be.true;
  });
});