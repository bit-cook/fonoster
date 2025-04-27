/**
 * Copyright (C) 2025 by Fonoster Inc (https://fonoster.com)
 * http://github.com/fonoster/fonoster
 *
 * This file is part of Fonoster
 *
 * Licensed under the MIT License (the "License");
 * you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 *
 *    https://opensource.org/licenses/MIT
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { Stream } from "stream";
import { AuthzClient } from "@fonoster/authz";
import {
  GrpcError,
  SayOptions,
  StreamEvent,
  VoiceClientConfig,
  VoiceIn,
  VoiceSessionStreamClient
} from "@fonoster/common";
import { getLogger } from "@fonoster/logger";
import { AudioSocket, AudioStream } from "@fonoster/streams";
import * as grpc from "@grpc/grpc-js";
import { Bridge, Client } from "ari-client";
import { pickPort } from "pick-port";
import {
  AUTHZ_SERVICE_ENABLED,
  AUTHZ_SERVICE_HOST,
  AUTHZ_SERVICE_PORT
} from "../envs";
import { SpeechResult } from "./stt/types";
import { transcribeOnConnection } from "./transcribeOnConnection";
import {
  AriEvent,
  GRPCClient,
  SpeechToText,
  TextToSpeech,
  VoiceClient
} from "./types";
import { createExternalMediaConfig } from "./utils/createExternalMediaConfig";
import { VoiceServiceClientConstructor } from "./utils/VoiceServiceClientConstructor";

const logger = getLogger({ service: "apiserver", filePath: __filename });

class VoiceClientImpl implements VoiceClient {
  config: VoiceClientConfig;
  verbsStream: Stream;
  transcriptionsStream: Stream;
  voice: VoiceSessionStreamClient;
  tts: TextToSpeech;
  stt: SpeechToText;
  grpcClient: GRPCClient;
  audioSocket: AudioSocket;
  audioStream: AudioStream;
  ari: Client;
  bridge: Bridge;

  constructor(params: {
    ari: Client;
    config: VoiceClientConfig;
    tts: TextToSpeech;
    stt: SpeechToText;
  }) {
    const { config, tts, stt, ari } = params;
    this.config = config;
    this.verbsStream = new Stream();
    this.transcriptionsStream = new Stream();
    this.tts = tts;
    this.stt = stt;
    this.ari = ari;
  }

  async connect() {
    if (AUTHZ_SERVICE_ENABLED) {
      const { sessionRef: channelId } = this.config;
      const { ari } = this;

      try {
        const authz = new AuthzClient(
          `${AUTHZ_SERVICE_HOST}:${AUTHZ_SERVICE_PORT}`
        );
        const authorized = await authz.checkSessionAuthorized({
          accessKeyId: this.config.accessKeyId
        });

        if (!authorized) {
          logger.verbose("rejected unauthorized session", { channelId });

          await ari.channels.answer({ channelId });
          await ari.channels.play({ channelId, media: "sound:unavailable" });
          await new Promise((resolve) => setTimeout(resolve, 2000));
          await ari.channels.hangup({ channelId });
          return;
        }
      } catch (e) {
        logger.error("authz service error", e);

        await ari.channels.answer({ channelId });
        await ari.channels.play({ channelId, media: "sound:unavailable" });
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await ari.channels.hangup({ channelId });
        return;
      }
    }

    this.grpcClient = new VoiceServiceClientConstructor(
      this.config.endpoint,
      grpc.credentials.createInsecure()
    ) as unknown as GRPCClient;

    const metadata = new grpc.Metadata();
    metadata.add("accessKeyId", this.config.accessKeyId);
    metadata.add("token", this.config.sessionToken);

    this.voice = this.grpcClient.createSession(metadata);

    this.voice.on(StreamEvent.DATA, (data: VoiceIn) => {
      this.verbsStream.emit(data.content, data);
    });

    this.voice.write({ request: this.config });

    this.voice.on(StreamEvent.ERROR, (error: GrpcError) => {
      if (error.code === grpc.status.UNAVAILABLE) {
        // FIXME: This error should be sent back to the user
        logger.error(`voice server not available at "${this.config.endpoint}"`);
        return;
      }
      logger.error(error.message);
    });

    const externalMediaPort = await pickPort({ type: "tcp" });
    logger.verbose("picked external media port", { port: externalMediaPort });

    // Wait for both audio socket and external media setup to complete
    await Promise.all([
      this.setupAudioSocket(externalMediaPort),
      this.setupExternalMedia(externalMediaPort)
    ]);

    logger.verbose("voice client setup completed");
  }

  async setupExternalMedia(port: number) {
    const bridge = this.ari.Bridge();
    const channel = this.ari.Channel();

    await bridge.create({ type: "mixing" });

    channel.externalMedia(createExternalMediaConfig(port));

    channel.once(AriEvent.STASIS_START, async (_, channel) => {
      bridge.addChannel({ channel: [this.config.sessionRef, channel.id] });
    });

    channel.once("ChannelLeftBridge", async () => {
      try {
        await bridge.destroy();
      } catch (e) {
        // We can only try
      }
    });

    this.bridge = bridge;
  }

  async synthesize(text: string, options: SayOptions): Promise<string> {
    const { ref, stream } = this.tts.synthesize(text, options);

    logger.verbose("starting audio synthesis", { ref });

    try {
      // Stop any active stream
      this.audioStream.stopPlayStream();
      await this.audioStream.playStream(stream);
    } catch (error) {
      logger.error(`stream error for ref ${ref}: ${error.message}`, {
        errorDetails: error.stack || "No stack trace"
      });
    }

    return ref;
  }

  async stopSynthesis() {
    this.audioStream.stopPlayStream();
  }

  async transcribe(): Promise<SpeechResult> {
    try {
      return await this.stt.transcribe(this.transcriptionsStream);
    } catch (e) {
      logger.warn("transcription error", e);
      return {} as unknown as SpeechResult;
    }
  }

  async startDtmfGather(
    sessionRef: string,
    callback: (event: { digit: string }) => void
  ) {
    const channel = await this.ari.channels.get({ channelId: sessionRef });

    channel.on(AriEvent.CHANNEL_DTMF_RECEIVED, (event) => {
      const { digit } = event;
      callback({ digit });
    });
  }

  // Stops both speech and dtmf gather
  async stopStreamGather() {
    throw new Error("Method 'stopStreamGather' not implemented.");
  }

  async waitForDtmf(params: {
    sessionRef: string;
    finishOnKey: string;
    maxDigits: number;
    timeout: number;
    onDigitReceived: () => void;
  }): Promise<{ digits: string }> {
    const { onDigitReceived, sessionRef, finishOnKey, maxDigits, timeout } =
      params;

    let result = "";
    let timeoutId = null;

    const channel = await this.ari.channels.get({ channelId: sessionRef });

    return new Promise((resolve) => {
      const resetTimer = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        timeoutId = setTimeout(() => {
          channel.removeListener(AriEvent.CHANNEL_DTMF_RECEIVED, dtmfListener);
          resolve({ digits: result });
        }, timeout);
      };

      const dtmfListener = (event) => {
        const { digit } = event;

        // Stops the global timeout
        onDigitReceived();
        resetTimer();

        if (digit !== finishOnKey) {
          result += digit;
        }

        if (result.length >= maxDigits || digit === finishOnKey) {
          clearTimeout(timeoutId);
          channel.removeListener(AriEvent.CHANNEL_DTMF_RECEIVED, dtmfListener);
          resolve({ digits: result });
        }
      };

      channel.on(AriEvent.CHANNEL_DTMF_RECEIVED, dtmfListener);
      resetTimer(); // Start the initial timeout
    });
  }

  setupAudioSocket(port: number): Promise<void> {
    return new Promise((resolve) => {
      logger.verbose("creating audio socket", { port });
      this.audioSocket = new AudioSocket();

      this.audioSocket.onConnection(async (req, res) => {
        logger.verbose("audio socket connection received", {
          ref: req.ref,
          sessionRef: this.config.sessionRef
        });

        transcribeOnConnection(this.transcriptionsStream)(req, res);

        res.onClose(() => {
          logger.verbose("session audio stream closed", {
            sessionRef: this.config.sessionRef
          });
        });

        res.onError((err) => {
          logger.error("session audio stream error", {
            error: err,
            sessionRef: this.config.sessionRef
          });
        });

        this.audioStream = res;

        resolve();
      });

      this.audioSocket.listen(port, () => {
        logger.verbose("audio socket listening", {
          port,
          appRef: this.config.appRef
        });
      });
    });
  }

  sendResponse(response: VoiceIn): void {
    this.voice.write(response);
  }

  getTranscriptionsStream() {
    return this.transcriptionsStream;
  }

  startSpeechGather(
    callback: (stream: { speech: string; responseTime: number }) => void
  ) {
    const out = this.stt.streamTranscribe(this.transcriptionsStream);

    out.on("data", callback);

    out.on("error", async (error) => {
      logger.error("speech recognition error", { error });

      const { sessionRef: channelId } = this.config;
      const { ari } = this;

      ari.channels.hangup({ channelId });
    });
  }

  on(type: string, callback: (data: VoiceIn) => void) {
    this.verbsStream.on(type.toString(), (data: VoiceIn) => {
      callback(data[type]);
    });
  }

  close() {
    try {
      this.voice.end();
      this.grpcClient.close();
      this.audioSocket.close();
    } catch (e) {
      // Do nothing
    }
  }
}

export { VoiceClientImpl };
