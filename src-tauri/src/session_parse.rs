//! JSONL 会话解析（从 Python conversation_viewer 移植）。
//!
//! 只关心「主人真正说的话」+ 紧随其后的 AI 文字回复，滤掉 tool_result /
//! 本地命令 / 系统注入 / sidechain。对单个会话文件的完整文本做一次扫描，
//! 同时抽出标题、gitBranch、cwd、最后活跃时间。本机读文件系统、远程拉原始字节，
//! 都喂给同一个解析器，保证两侧行为一致。

use chrono::{DateTime, Local};
use serde_json::Value;

/// 一条「我的发言 + 折叠回复」
pub struct UserTurn {
    pub ts: String,
    pub ts_unix: Option<i64>,
    pub local_date: String,
    pub text: String,
    pub chars: i64,
    pub reply: String,
    pub reply_chars: i64,
    /// 该条消息附带的图片本机路径（按 [Image #N] 顺序），来自紧随其后的来源注释事件
    pub images: Vec<String>,
}

/// 单会话解析结果
pub struct SessionMeta {
    pub title: String,
    pub git_branch: String,
    pub cwd: String,
    pub last_unix: i64,
    pub turns: Vec<UserTurn>,
}

/// ISO 时间戳 → UTC 秒级时间戳
fn iso_to_unix(ts: &str) -> Option<i64> {
    if ts.is_empty() {
        return None;
    }
    DateTime::parse_from_rfc3339(ts).ok().map(|dt| dt.timestamp())
}

/// ISO 时间戳 → 本机本地日期 YYYY-MM-DD
fn iso_to_local_date(ts: &str) -> String {
    if ts.is_empty() {
        return "未知".to_string();
    }
    match DateTime::parse_from_rfc3339(ts) {
        Ok(dt) => dt.with_timezone(&Local).format("%Y-%m-%d").to_string(),
        Err(_) => "未知".to_string(),
    }
}

/// 拼接 content 数组里的 text 块
fn join_text_blocks(arr: &[Value]) -> String {
    arr.iter()
        .filter(|x| x.get("type").and_then(|v| v.as_str()) == Some("text"))
        .filter_map(|x| x.get("text").and_then(|v| v.as_str()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// 从 user 行提取主人真实输入；工具结果 / 命令 / 系统注入 / sidechain 返回 None
fn extract_user_text(obj: &Value) -> Option<String> {
    if obj.get("type").and_then(|v| v.as_str()) != Some("user") {
        return None;
    }
    if obj.get("isSidechain").and_then(|v| v.as_bool()) == Some(true) {
        return None;
    }
    let content = obj.get("message").and_then(|m| m.get("content"))?;
    let text = if let Some(arr) = content.as_array() {
        if arr
            .iter()
            .any(|x| x.get("type").and_then(|v| v.as_str()) == Some("tool_result"))
        {
            return None;
        }
        join_text_blocks(arr)
    } else if let Some(s) = content.as_str() {
        s.to_string()
    } else {
        return None;
    };

    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    let head: String = t.chars().take(60).collect();
    if t.starts_with('<')
        || t.starts_with("Caveat:")
        || head.contains("local-command")
        || t.starts_with("[Request interrupted")
        // harness/ShareX 给图片附的来源路径注释，自成一条 user 事件，不是真实发言
        || t.starts_with("[Image: source:")
    {
        return None;
    }
    Some(t.to_string())
}

/// 从「图片来源注释」事件提取本机路径：整条 user 文本形如 `[Image: source: <路径>]`
fn extract_image_source(obj: &Value) -> Option<String> {
    if obj.get("type").and_then(|v| v.as_str()) != Some("user") {
        return None;
    }
    if obj.get("isSidechain").and_then(|v| v.as_bool()) == Some(true) {
        return None;
    }
    let content = obj.get("message").and_then(|m| m.get("content"))?;
    let text = if let Some(arr) = content.as_array() {
        join_text_blocks(arr)
    } else if let Some(s) = content.as_str() {
        s.to_string()
    } else {
        return None;
    };
    let t = text.trim();
    let inner = t.strip_prefix("[Image: source:")?.strip_suffix(']')?;
    let path = inner.trim();
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

/// 从 assistant 行提取回复正文（仅 text 块）
fn extract_assistant_text(obj: &Value) -> Option<String> {
    if obj.get("type").and_then(|v| v.as_str()) != Some("assistant") {
        return None;
    }
    let content = obj.get("message").and_then(|m| m.get("content"))?;
    let text = if let Some(arr) = content.as_array() {
        join_text_blocks(arr)
    } else if let Some(s) = content.as_str() {
        s.to_string()
    } else {
        return None;
    };
    let t = text.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

fn flush(cur: &mut Option<UserTurn>, reply_parts: &mut Vec<String>, turns: &mut Vec<UserTurn>) {
    if let Some(mut t) = cur.take() {
        let reply = reply_parts.join("\n\n");
        t.reply_chars = reply.chars().count() as i64;
        t.reply = reply;
        turns.push(t);
    }
    reply_parts.clear();
}

/// 解析单个会话文件的完整文本
pub fn parse_session(content: &str, session_id: &str) -> SessionMeta {
    let mut turns: Vec<UserTurn> = Vec::new();
    let mut cur: Option<UserTurn> = None;
    let mut reply_parts: Vec<String> = Vec::new();

    let mut cwd = String::new();
    let mut ai_title: Option<String> = None;
    let mut first_prompt: Option<String> = None;
    let mut git_branch = String::new();
    let mut last_unix: i64 = 0;

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let obj: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if cwd.is_empty() {
            if let Some(c) = obj.get("cwd").and_then(|v| v.as_str()) {
                if !c.is_empty() {
                    cwd = c.to_string();
                }
            }
        }
        if ai_title.is_none() && obj.get("type").and_then(|v| v.as_str()) == Some("ai-title") {
            if let Some(t) = obj.get("aiTitle").and_then(|v| v.as_str()) {
                if !t.is_empty() {
                    ai_title = Some(t.to_string());
                }
            }
        }
        if git_branch.is_empty() {
            if let Some(b) = obj.get("gitBranch").and_then(|v| v.as_str()) {
                if !b.is_empty() {
                    git_branch = b.to_string();
                }
            }
        }
        if let Some(ts) = obj.get("timestamp").and_then(|v| v.as_str()) {
            if let Some(u) = iso_to_unix(ts) {
                if u > last_unix {
                    last_unix = u;
                }
            }
        }

        // 图片来源注释：不算一句发言，把路径挂到当前这条消息上
        if let Some(path) = extract_image_source(&obj) {
            if let Some(c) = cur.as_mut() {
                c.images.push(path);
            }
            continue;
        }

        if let Some(ut) = extract_user_text(&obj) {
            flush(&mut cur, &mut reply_parts, &mut turns);
            if first_prompt.is_none() {
                first_prompt = Some(ut.lines().next().unwrap_or("").trim().to_string());
            }
            let ts = obj
                .get("timestamp")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            cur = Some(UserTurn {
                ts_unix: iso_to_unix(&ts),
                local_date: iso_to_local_date(&ts),
                chars: ut.chars().count() as i64,
                text: ut,
                ts,
                reply: String::new(),
                reply_chars: 0,
                images: Vec::new(),
            });
        } else if let Some(at) = extract_assistant_text(&obj) {
            if cur.is_some() {
                reply_parts.push(at);
            }
        }
    }
    flush(&mut cur, &mut reply_parts, &mut turns);

    let title = ai_title
        .or_else(|| first_prompt.filter(|s| !s.is_empty()))
        .unwrap_or_else(|| session_id.chars().take(8).collect());

    SessionMeta {
        title,
        git_branch,
        cwd,
        last_unix,
        turns,
    }
}
