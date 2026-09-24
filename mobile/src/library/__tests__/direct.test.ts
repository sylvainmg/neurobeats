/**
 * Ce que le mini-navigateur reconnaît, et le flux qu'il garde.
 *
 * Côté pur, pas de module natif : reconnaître qu'une URL YouTube parle d'une
 * vidéo, et choisir parmi les formats le plus lisible. Le reste (extraction
 * yt-dlp, transfert) réclame un appareil et ne se teste pas ici.
 */
import { describe, expect, it } from "@jest/globals";

import {
  choisirFormatAudio,
  videoIdDepuisUrl,
  type FormatAudio,
} from "@/library/direct";

describe("videoIdDepuisUrl", () => {
  it("lit une adresse /watch classique", () => {
    expect(videoIdDepuisUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=abc")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  it("lit un short", () => {
    expect(videoIdDepuisUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  it("lit une adresse embarquée", () => {
    expect(videoIdDepuisUrl("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  it("lit un partage youtu.be", () => {
    expect(videoIdDepuisUrl("https://youtu.be/dQw4w9WgXcQ?t=10")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  it("refuse une page qui n'est pas une vidéo", () => {
    expect(videoIdDepuisUrl("https://www.youtube.com/@channel")).toBeNull();
    expect(videoIdDepuisUrl("https://exemple.com")).toBeNull();
    expect(videoIdDepuisUrl("pas une url")).toBeNull();
  });
});

describe("choisirFormatAudio", () => {
  const format = (partiel: Partial<FormatAudio>): FormatAudio => ({
    format_id: "id",
    ext: "m4a",
    abr: 128,
    acodec: "mp4a.40.2",
    url: "https://example.com/audio",
    ...partiel,
  });

  it("préfère le m4a le plus haut débit", () => {
    const formats = [
      format({ format_id: "bas", ext: "m4a", abr: 80, url: "https://a" }),
      format({ format_id: "haut", ext: "m4a", abr: 256, url: "https://b" }),
    ];
    expect(choisirFormatAudio(formats)?.format_id).toBe("haut");
  });

  it("retombe sur opus/webm quand le m4a n'existe pas", () => {
    const formats = [
      format({ format_id: "opus", ext: "opus", abr: 160, url: "https://c" }),
      format({ format_id: "m4aPiège", ext: "m4a", abr: 0, url: undefined }),
    ];
    expect(choisirFormatAudio(formats)?.format_id).toBe("opus");
  });

  it("écarte les flux vidéo seule (acodec none)", () => {
    const audio = format({ format_id: "audio", url: "https://d" });
    const vide = format({ acodec: "none", format_id: "video", url: "https://e" });
    expect(choisirFormatAudio([vide, audio])?.format_id).toBe("audio");
  });

  it("refuse une liste sans aucun flux téléchargeable", () => {
    expect(choisirFormatAudio([format({ url: undefined })])).toBeNull();
    expect(choisirFormatAudio([])).toBeNull();
  });
});