/**
 * The whisper models a person may have the desktop download — one plain table.
 *
 * Downloaded from upstream (huggingface.co/ggerganov/whisper.cpp, MIT) on a
 * person's request and verified against the pinned sha256; never bundled or
 * redistributed. `deploy/install.sh.tmpl` mirrors this table (a sync test pins
 * it), so it stays a plain literal: no computed fields except `dictateModelUrl`.
 */
export interface DictateModel {
  id: string;
  file: string;
  bytes: number;
  sha256: string;
  note: string;
  recommended: boolean;
}

export const DICTATE_MODEL_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

export const DICTATE_MODELS: readonly DictateModel[] = [
  {
    id: "turbo-q8", file: "ggml-large-v3-turbo-q8_0.bin", bytes: 874188075,
    sha256: "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1",
    note: "Recommended: the accuracy of the full turbo model with about 40% less memory.",
    recommended: true,
  },
  {
    id: "turbo", file: "ggml-large-v3-turbo.bin", bytes: 1624555275,
    sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
    note: "Full-precision large-v3-turbo; the largest download.",
    recommended: false,
  },
  {
    id: "small", file: "ggml-small.bin", bytes: 487601967,
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    note: "Smaller and lighter, but 25-45% more word errors in German.",
    recommended: false,
  },
];

export function dictateModelUrl(m: Pick<DictateModel, "file">): string {
  return DICTATE_MODEL_BASE_URL + m.file;
}

export function dictateModelById(id: string): DictateModel | undefined {
  return DICTATE_MODELS.find((m) => m.id === id);
}

/** Free space a download must leave untouched: a full disk on this desktop
 *  ends Tailscale, so the model never takes the last 2 GB. */
export const DICTATE_DISK_MARGIN_BYTES = 2 * 1024 * 1024 * 1024;
