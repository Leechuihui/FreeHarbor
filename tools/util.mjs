#!/usr/bin/env node
/**
 * util.mjs — 各脚本共用的容错小工具
 *
 * 上游订阅是野生的：fragment / 用户名里常带畸形的百分号转义
 * （`#%V2raySaman`、`pa%Vss`）。`new URL()` 能吞下去，但
 * `decodeURIComponent()` 会直接抛 URIError，把整轮 CI 打断。
 * 这里统一走容错解码，坏转义原样保留而不是抛异常。
 */

/** 能解就解，解不动就退回原文（绝不抛） */
export function dec(s) {
  if (!s) return '';
  try {
    return decodeURIComponent(s);
  } catch {
    // 整串解不动就逐段解：只保留能解的段，坏段原样留着
    return String(s)
      .split(/(?=%)/)
      .map((part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          return part;
        }
      })
      .join('');
  }
}

/** URI 里 # 之后的部分（没有 # 返回空串） */
export function fragmentOf(raw) {
  const i = raw.indexOf('#');
  return i < 0 ? '' : raw.slice(i + 1);
}

/** URI 里的用户名部分，容错解码；解析失败返回空串 */
export function usernameOf(raw) {
  try {
    return dec(new URL(raw).username);
  } catch {
    return '';
  }
}
