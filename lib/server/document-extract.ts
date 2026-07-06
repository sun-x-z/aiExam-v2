import { inflateRawSync, inflateSync } from "node:zlib";
import type { FileKind, ParsedWorkbookSource } from "@/lib/types";

type ZipEntry = {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  localHeaderOffset: number;
};

function getExtension(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() || "";
}

function getFileKind(fileName: string): FileKind {
  const extension = getExtension(fileName);
  if (extension === "docx") return "word";
  if (extension === "pdf") return "pdf";
  if (extension === "xlsx" || extension === "xls") return "excel";
  return "text";
}

function decodeXml(value: string) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

function readUInt32(buffer: Buffer, offset: number) {
  return buffer.readUInt32LE(offset);
}

function readUInt16(buffer: Buffer, offset: number) {
  return buffer.readUInt16LE(offset);
}

function findEndOfCentralDirectory(buffer: Buffer) {
  const signature = 0x06054b50;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (readUInt32(buffer, offset) === signature) return offset;
  }
  throw new Error("DOCX ZIP 结构无效，未找到中央目录");
}

function listZipEntries(buffer: Buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const totalEntries = readUInt16(buffer, eocdOffset + 10);
  const centralDirectoryOffset = readUInt32(buffer, eocdOffset + 16);
  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (readUInt32(buffer, offset) !== 0x02014b50) break;
    const compressionMethod = readUInt16(buffer, offset + 10);
    const compressedSize = readUInt32(buffer, offset + 20);
    const uncompressedSize = readUInt32(buffer, offset + 24);
    const fileNameLength = readUInt16(buffer, offset + 28);
    const extraLength = readUInt16(buffer, offset + 30);
    const commentLength = readUInt16(buffer, offset + 32);
    const localHeaderOffset = readUInt32(buffer, offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString("utf8");
    entries.push({ name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function readZipEntry(buffer: Buffer, entry: ZipEntry) {
  const offset = entry.localHeaderOffset;
  if (readUInt32(buffer, offset) !== 0x04034b50) {
    throw new Error(`DOCX ZIP 本地文件头无效：${entry.name}`);
  }

  const fileNameLength = readUInt16(buffer, offset + 26);
  const extraLength = readUInt16(buffer, offset + 28);
  const dataOffset = offset + 30 + fileNameLength + extraLength;
  const compressed = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);

  if (entry.compressionMethod === 0) return compressed;
  if (entry.compressionMethod === 8) return inflateRawSync(compressed);
  throw new Error(`DOCX ZIP 压缩方式暂不支持：${entry.compressionMethod}`);
}

function extractDocxText(buffer: Buffer) {
  const entries = listZipEntries(buffer);
  const documentEntry = entries.find((entry) => entry.name === "word/document.xml");
  if (!documentEntry) throw new Error("DOCX 中未找到 word/document.xml");

  const xml = readZipEntry(buffer, documentEntry).toString("utf8");
  const tableRows: string[] = [];
  for (const rowMatch of xml.matchAll(/<w:tr[\s\S]*?<\/w:tr>/g)) {
    const cells = Array.from(rowMatch[0].matchAll(/<w:tc[\s\S]*?<\/w:tc>/g), (cellMatch) => {
      return Array.from(cellMatch[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g), (textMatch) => decodeXml(textMatch[1])).join("").trim();
    }).filter(Boolean);
    if (cells.length) tableRows.push(cells.join(" | "));
  }

  const paragraphTexts: string[] = [];
  const paragraphMatches = xml.matchAll(/<w:p[\s\S]*?<\/w:p>/g);

  for (const paragraphMatch of paragraphMatches) {
    const paragraph = paragraphMatch[0]
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:br\/>/g, "\n")
      .replace(/<\/w:tc>/g, " | ");
    const text = Array.from(paragraph.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g), (match) => decodeXml(match[1])).join("");
    if (text.trim()) paragraphTexts.push(text.trim());
  }

  return [...tableRows, ...paragraphTexts].join("\n");
}

function decodePdfEscapes(value: string) {
  return value
    .replace(/\\([nrtbf()\\])/g, (_match, escape: string) => {
      const map: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
      return map[escape] ?? escape;
    })
    .replace(/\\([0-7]{1,3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function extractPdfStringLiterals(stream: string) {
  const values: string[] = [];
  const regex = /\((?:\\.|[^\\)])*\)/g;
  for (const match of stream.matchAll(regex)) {
    values.push(decodePdfEscapes(match[0].slice(1, -1)));
  }
  return values.join(" ");
}

function extractPdfHexStrings(stream: string) {
  const values: string[] = [];
  for (const match of stream.matchAll(/<([0-9A-Fa-f\s]+)>/g)) {
    const hex = match[1].replace(/\s+/g, "");
    if (hex.length < 4 || hex.length % 2 !== 0) continue;
    const bytes = Buffer.from(hex, "hex");
    if (hex.startsWith("FEFF") || hex.startsWith("feff")) {
      values.push(bytes.subarray(2).toString("utf16le"));
      continue;
    }
    const ascii = bytes.toString("utf8").replace(/[^\x09\x0A\x0D\x20-\x7E\u4E00-\u9FFF]+/g, " ").trim();
    if (ascii) values.push(ascii);
  }
  return values.join(" ");
}

function tryInflatePdfStream(data: Buffer) {
  try {
    return inflateSync(data);
  } catch {
    try {
      return inflateRawSync(data);
    } catch {
      return data;
    }
  }
}

function extractPdfText(buffer: Buffer) {
  const binary = buffer.toString("latin1");
  const streams: string[] = [];
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;

  for (const match of binary.matchAll(streamRegex)) {
    const data = Buffer.from(match[1], "latin1");
    const inflated = tryInflatePdfStream(data);
    const streamText = inflated.toString("latin1");
    const literalText = [extractPdfStringLiterals(streamText), extractPdfHexStrings(streamText)].filter(Boolean).join(" ");
    if (literalText.trim()) streams.push(literalText);
  }

  const joined = streams.join("\n").replace(/\s{2,}/g, " ").trim();
  if (joined) return joined;

  return binary
    .replace(/[^\x09\x0A\x0D\x20-\x7E\u4E00-\u9FFF]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export async function extractDocumentSource(file: File): Promise<ParsedWorkbookSource> {
  const fileKind = getFileKind(file.name);
  const buffer = Buffer.from(await file.arrayBuffer());
  let textContent = "";

  if (fileKind === "word") {
    textContent = extractDocxText(buffer);
  } else if (fileKind === "pdf") {
    textContent = extractPdfText(buffer);
  } else if (fileKind === "text") {
    textContent = buffer.toString("utf8");
  } else {
    throw new Error("服务端文本提取仅支持 Word / PDF / Text");
  }

  const normalizedText = textContent.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return {
    fileName: file.name,
    fileKind,
    sheets: [],
    textContent: normalizedText,
    sampleText: normalizedText.slice(0, 12000),
  };
}
