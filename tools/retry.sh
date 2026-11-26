#!/usr/bin/env bash
# retry.sh — 供 workflow 各步 source 的重试助手
#
# 用法: source tools/retry.sh; retry <次数> <退避秒> <命令...>
# 上游源站 5xx / DNS 抖动 / 内核下载超时都是常态，靠退避重试吸收，
# 而不是让一次抖动把整轮刷新打挂、白等 3 小时。

retry() {
  local n=$1 delay=$2
  shift 2
  local i
  for ((i = 1; i <= n; i++)); do
    if "$@"; then
      return 0
    fi
    echo "::warning::第 $i/$n 次失败: $*"
    if [ "$i" -lt "$n" ]; then
      sleep "$delay"
    fi
  done
  return 1
}
