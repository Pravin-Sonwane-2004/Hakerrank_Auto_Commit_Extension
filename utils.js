(function exposeUtils(global) {
  "use strict";

  const APP_PREFIX = "hrgs";

  const STORAGE_KEYS = Object.freeze({
    settings: `${APP_PREFIX}:settings`,
    history: `${APP_PREFIX}:history`,
    lastStatus: `${APP_PREFIX}:lastStatus`
  });

  const DEFAULT_SETTINGS = Object.freeze({
    githubToken: "",
    owner: "",
    repo: "",
    branch: "main"
  });

  const LANGUAGE_CONFIG = Object.freeze({
    java: {
      label: "Java",
      folder: "Java",
      extension: "java",
      aliases: ["java", "java 8", "java 15", "java 17"]
    },
    sql: {
      label: "SQL",
      folder: "SQL",
      extension: "sql",
      aliases: ["sql", "mysql", "ms sql", "oracle", "db2"]
    },
    python: {
      label: "Python",
      folder: "Python",
      extension: "py",
      aliases: ["python", "python 2", "python 3", "pypy", "pypy3"]
    },
    javascript: {
      label: "JavaScript",
      folder: "JavaScript",
      extension: "js",
      aliases: ["javascript", "node.js", "nodejs", "js", "ecmascript"]
    },
    cpp: {
      label: "C++",
      folder: "Cpp",
      extension: "cpp",
      aliases: ["c++", "cpp", "g++", "c++14", "c++20"]
    }
  });

  const ALIAS_TO_LANGUAGE = Object.entries(LANGUAGE_CONFIG).reduce((index, [key, config]) => {
    config.aliases.forEach((alias) => {
      index[normalizeLanguageText(alias)] = key;
    });
    return index;
  }, {});

  function normalizeLanguageText(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/\(.*?\)/g, "")
      .trim();
  }

  function normalizeLanguage(value) {
    const text = normalizeLanguageText(value)
      .replace(/^language[:\s-]*/i, "")
      .replace(/^select language[:\s-]*/i, "")
      .trim();

    if (ALIAS_TO_LANGUAGE[text]) {
      return ALIAS_TO_LANGUAGE[text];
    }

    if (text.includes("java") && !text.includes("script")) {
      return "java";
    }

    if (text.includes("javascript") || text.includes("node")) {
      return "javascript";
    }

    if (text.includes("python") || text.includes("pypy")) {
      return "python";
    }

    if (text.includes("sql") || text.includes("mysql") || text.includes("oracle")) {
      return "sql";
    }

    if (text.includes("c++") || text.includes("cpp") || text.includes("g++")) {
      return "cpp";
    }

    return "";
  }

  function getLanguageConfig(language) {
    const normalized = normalizeLanguage(language);
    return LANGUAGE_CONFIG[normalized] || null;
  }

  function cleanProblemTitle(title) {
    return String(title || "")
      .replace(/\s*\|\s*HackerRank\s*$/i, "")
      .replace(/\s*-\s*HackerRank\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function titleToPascalFileName(title) {
    const cleaned = cleanProblemTitle(title)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/&/g, " and ")
      .replace(/[^a-zA-Z0-9]+/g, " ")
      .trim();

    const words = cleaned.match(/[a-zA-Z0-9]+/g) || ["Solution"];
    const fileName = words
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join("");

    return fileName || "Solution";
  }

  function buildSolutionPath({ title, language }) {
    const config = getLanguageConfig(language);

    if (!config) {
      throw new Error(`Unsupported language: ${language || "unknown"}`);
    }

    return `HackerRank/${config.folder}/${titleToPascalFileName(title)}.${config.extension}`;
  }

  function buildCommitMessage(title) {
    return `HackerRank: Solved ${cleanProblemTitle(title) || "Challenge"}`;
  }

  function canonicalProblemUrl(url) {
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      parsed.search = "";
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
      return parsed.toString();
    } catch (_) {
      return String(url || "").split(/[?#]/)[0].replace(/\/+$/, "");
    }
  }

  function normalizeCodeForHash(code) {
    return String(code || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim();
  }

  function normalizeCodeForCommit(code) {
    const normalized = String(code || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
    return `${normalized}\n`;
  }

  async function hashString(value) {
    const data = new TextEncoder().encode(String(value || ""));
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  async function makeSubmissionKey({ problemUrl, language, code }) {
    const codeHash = await hashString(normalizeCodeForHash(code));
    const source = [
      canonicalProblemUrl(problemUrl),
      normalizeLanguage(language),
      codeHash
    ].join("|");

    return hashString(source);
  }

  function utf8ToBase64(value) {
    const bytes = new TextEncoder().encode(String(value || ""));
    let binary = "";
    const chunkSize = 0x8000;

    for (let index = 0; index < bytes.length; index += chunkSize) {
      const chunk = bytes.subarray(index, index + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }

    return btoa(binary);
  }

  function base64ToUtf8(value) {
    const clean = String(value || "").replace(/\s/g, "");
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return new TextDecoder().decode(bytes);
  }

  function storageGet(keys) {
    return chrome.storage.local.get(keys);
  }

  function storageSet(values) {
    return chrome.storage.local.set(values);
  }

  function storageRemove(keys) {
    return chrome.storage.local.remove(keys);
  }

  function sendRuntimeMessage(message) {
    return chrome.runtime.sendMessage(message);
  }

  function toErrorMessage(error) {
    if (!error) {
      return "Unknown error";
    }

    if (typeof error === "string") {
      return error;
    }

    return error.message || JSON.stringify(error);
  }

  function truncate(value, maxLength) {
    const text = String(value || "");

    if (text.length <= maxLength) {
      return text;
    }

    return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
  }

  function formatDateTime(value) {
    if (!value) {
      return "Never";
    }

    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short"
      }).format(new Date(value));
    } catch (_) {
      return String(value);
    }
  }

  function isAcceptedText(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();

    return [
      /\bAccepted\b/i,
      /\bCongratulations\b.*\bsolved\b/i,
      /\bAll test cases passed\b/i,
      /\bYour code passed all test cases\b/i
    ].some((pattern) => pattern.test(text));
  }

  function isHackerRankUrl(value) {
    try {
      const url = new URL(value);
      return url.hostname === "hackerrank.com" || url.hostname.endsWith(".hackerrank.com");
    } catch (_) {
      return false;
    }
  }

  function isChallengeUrl(value) {
    try {
      const url = new URL(value);
      return isHackerRankUrl(url.toString()) && /\/challenges\//i.test(url.pathname);
    } catch (_) {
      return false;
    }
  }

  function debounce(fn, wait) {
    let timer = 0;

    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  function mergeSettings(settings) {
    return {
      ...DEFAULT_SETTINGS,
      ...(settings || {})
    };
  }

  function maskToken(token) {
    const value = String(token || "");

    if (!value) {
      return "";
    }

    if (value.length <= 8) {
      return "********";
    }

    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }

  global.HRGitHubSyncUtils = Object.freeze({
    APP_PREFIX,
    STORAGE_KEYS,
    DEFAULT_SETTINGS,
    LANGUAGE_CONFIG,
    base64ToUtf8,
    buildCommitMessage,
    buildSolutionPath,
    canonicalProblemUrl,
    cleanProblemTitle,
    debounce,
    formatDateTime,
    getLanguageConfig,
    hashString,
    isAcceptedText,
    isChallengeUrl,
    isHackerRankUrl,
    makeSubmissionKey,
    maskToken,
    mergeSettings,
    normalizeCodeForCommit,
    normalizeCodeForHash,
    normalizeLanguage,
    normalizeLanguageText,
    sendRuntimeMessage,
    storageGet,
    storageRemove,
    storageSet,
    titleToPascalFileName,
    toErrorMessage,
    truncate,
    utf8ToBase64
  });
})(globalThis);
