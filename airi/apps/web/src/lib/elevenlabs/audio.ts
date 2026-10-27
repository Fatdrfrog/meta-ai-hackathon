/** Normalize provider output for file storage and browser playback. */
export function normalizeElevenLabsAudio(params: {
  buffer: Buffer;
  outputFormat: string;
  contentType?: string | null;
}): { buffer: Buffer; mimeType: string } {
  const { buffer } = params;
  if (!buffer.length) throw new Error("ElevenLabs returned empty audio");

  const outputFormat = params.outputFormat.trim().toLowerCase();
  if (outputFormat.startsWith("pcm_")) {
    const sampleRate = Number(outputFormat.slice(4));
    if (
      !Number.isInteger(sampleRate) ||
      sampleRate < 8000 ||
      sampleRate > 48000
    ) {
      throw new Error("Invalid ElevenLabs PCM sample rate");
    }
    if (buffer.length % 2 !== 0) {
      throw new Error("ElevenLabs returned incomplete PCM audio");
    }

    // ElevenLabs PCM output is mono signed 16-bit little-endian without a container.
    // File consumers need a WAV header; declaring audio/wav alone is insufficient.
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + buffer.length, 4);
    header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(buffer.length, 40);
    return { buffer: Buffer.concat([header, buffer]), mimeType: "audio/wav" };
  }

  const contentType = params.contentType?.split(";")[0]?.trim().toLowerCase();
  const mimeType = contentType?.startsWith("audio/")
    ? contentType
    : outputFormat.startsWith("wav")
      ? "audio/wav"
      : outputFormat.startsWith("opus")
        ? "audio/ogg"
        : outputFormat.startsWith("ulaw")
          ? "audio/basic"
          : "audio/mpeg";
  return { buffer, mimeType };
}
