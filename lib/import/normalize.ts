const SEPARATORS = /[\s_\-./\\,:;|~`'"'“”‘’()[\]{}<>【】（）]+/g;

export function normalizeText(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(SEPARATORS, "");
}

export function fingerprintHeaders(headers: string[]) {
  return headers.map((header) => normalizeText(header)).join("|");
}

