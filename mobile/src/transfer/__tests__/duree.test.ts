/**
 * Sondage de la durée d'un fichier local.
 *
 * Le sondeur ne doit jamais jouer un son : il lit la durée portée par le
 * lecteur, puis le détruit. Un fichier muet (durée jamais fournie) renonce
 * proprement au lieu de bloquer.
 */
import { createAudioPlayer } from "expo-audio";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import { dureeDeFichier } from "@/transfer/duree";

jest.mock("expo-audio", () => {
  const { jest: j } = require("@jest/globals");
  return { createAudioPlayer: j.fn() };
});

const createAudioPlayerMock = createAudioPlayer as jest.Mock;

describe("dureeDeFichier", () => {
  beforeEach(() => {
    createAudioPlayerMock.mockReset();
  });

  it("lit la durée déjà portée par le lecteur", async () => {
    createAudioPlayerMock.mockReturnValue({ duration: 197, remove: jest.fn() });
    await expect(dureeDeFichier("file:///musique/titre.m4a")).resolves.toBe(197);
    expect(createAudioPlayerMock).toHaveBeenLastCalledWith({
      uri: "file:///musique/titre.m4a",
    });
  });

  it("renonce sans durée plutôt que de bloquer", async () => {
    jest.useFakeTimers();
    const joueur = { duration: 0, remove: jest.fn() };
    createAudioPlayerMock.mockReturnValue(joueur);
    const promesse = dureeDeFichier("file:///musique/muet.m4a");
    await jest.advanceTimersByTimeAsync(6100);
    await expect(promesse).resolves.toBeNull();
    expect(joueur.remove).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it("sans fichier, rien à sonder", async () => {
    await expect(dureeDeFichier(null)).resolves.toBeNull();
    await expect(dureeDeFichier("")).resolves.toBeNull();
    expect(createAudioPlayerMock).not.toHaveBeenCalled();
  });

  it("un lecteur indisponible ne fait pas échouer", async () => {
    createAudioPlayerMock.mockImplementation(() => {
      throw new Error("module manquant");
    });
    await expect(dureeDeFichier("file:///x")).resolves.toBeNull();
  });
});