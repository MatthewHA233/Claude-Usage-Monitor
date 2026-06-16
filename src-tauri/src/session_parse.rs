//! JSONL 会话解析（从 Python conversation_viewer 移植）。
//!
//! 只关心「主人真正说的话」+ 紧随其后的 AI 文字回复，滤掉 tool_result /
//! 本地命令 / 系统注入 / sidechain。对单个会话文件的完整文本做一次扫描，
//! 同时抽出标题、gitBranch、cwd、最后活跃时间。本机读文件系统、远程拉原始字节，
//! 都喂给同一个解析器，保证两侧行为一致。

use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 回复里的一个有序块：文字 或 工具调用。用于展开回复时按真实顺序交错展示。
#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "type")]
pub enum ReplyBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "tool")]
    Tool {
        /// tool_use 的 id（toolu_xxx），前端按需懒加载对应 tool_result 时用来定位
        id: String,
        name: String,
        input: Value,
    },
}

/// 一条「我的发言 + 折叠回复」
pub struct UserTurn {
    pub ts: String,
    pub ts_unix: Option<i64>,
    pub local_date: String,
    pub text: String,
    pub chars: i64,
    pub reply: String,
    pub reply_chars: i64,
    /// 回复的有序块（文字/工具调用交错），展开时还原 AI「边说边做」的过程
    pub blocks: Vec<ReplyBlock>,
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

/// 从「图片来源注释」事件提取本机路径。一条注释可含多行（多图各一行），
/// 每行形如 `[Image: source: <路径>]`，按行解析返回全部路径。
fn extract_image_sources(obj: &Value) -> Vec<String> {
    if obj.get("type").and_then(|v| v.as_str()) != Some("user") {
        return Vec::new();
    }
    if obj.get("isSidechain").and_then(|v| v.as_bool()) == Some(true) {
        return Vec::new();
    }
    let Some(content) = obj.get("message").and_then(|m| m.get("content")) else {
        return Vec::new();
    };
    let text = if let Some(arr) = content.as_array() {
        join_text_blocks(arr)
    } else if let Some(s) = content.as_str() {
        s.to_string()
    } else {
        return Vec::new();
    };
    let t = text.trim();
    if !t.starts_with("[Image: source:") {
        return Vec::new();
    }
    let mut paths = Vec::new();
    for line in t.lines() {
        if let Some(inner) = line
            .trim()
            .strip_prefix("[Image: source:")
            .and_then(|s| s.strip_suffix(']'))
        {
            let path = inner.trim();
            if !path.is_empty() {
                paths.push(path.to_string());
            }
        }
    }
    paths
}

/// 「工作中排队插话」：type=attachment 且 attachment.type=queued_command，
/// 用户真实输入在 attachment.prompt（这类不是 type=user，普通解析会漏掉）
fn extract_queued_prompt(obj: &Value) -> Option<String> {
    if obj.get("type").and_then(|v| v.as_str()) != Some("attachment") {
        return None;
    }
    let att = obj.get("attachment")?;
    if att.get("type").and_then(|v| v.as_str()) != Some("queued_command") {
        return None;
    }
    let prompt = att.get("prompt").and_then(|v| v.as_str())?;
    let t = prompt.trim();
    if t.is_empty() {
        return None;
    }
    let head: String = t.chars().take(60).collect();
    if t.starts_with('<')
        || t.starts_with("Caveat:")
        || head.contains("local-command")
        || t.starts_with("[Request interrupted")
        || t.starts_with("[Image: source:")
    {
        return None;
    }
    Some(t.to_string())
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

/// 从 assistant 行抽出有序块：text 块 → 文字，tool_use 块 → 工具调用（名称 + 入参）。
/// 一个 assistant 事件的 content 可能形如 [text, tool_use, text, ...]，按数组顺序保留。
fn extract_assistant_blocks(obj: &Value) -> Vec<ReplyBlock> {
    if obj.get("type").and_then(|v| v.as_str()) != Some("assistant") {
        return Vec::new();
    }
    let Some(content) = obj.get("message").and_then(|m| m.get("content")) else {
        return Vec::new();
    };
    let mut blocks: Vec<ReplyBlock> = Vec::new();
    if let Some(arr) = content.as_array() {
        for x in arr {
            match x.get("type").and_then(|v| v.as_str()) {
                Some("text") => {
                    if let Some(s) = x.get("text").and_then(|v| v.as_str()) {
                        let s = s.trim();
                        if !s.is_empty() {
                            blocks.push(ReplyBlock::Text { text: s.to_string() });
                        }
                    }
                }
                Some("tool_use") => {
                    let id = x.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let name = x
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("tool")
                        .to_string();
                    let input = x.get("input").cloned().unwrap_or(Value::Null);
                    blocks.push(ReplyBlock::Tool { id, name, input });
                }
                _ => {}
            }
        }
    } else if let Some(s) = content.as_str() {
        let s = s.trim();
        if !s.is_empty() {
            blocks.push(ReplyBlock::Text { text: s.to_string() });
        }
    }
    blocks
}

fn flush(
    cur: &mut Option<UserTurn>,
    reply_parts: &mut Vec<String>,
    reply_blocks: &mut Vec<ReplyBlock>,
    turns: &mut Vec<UserTurn>,
) {
    if let Some(mut t) = cur.take() {
        let reply = reply_parts.join("\n\n");
        t.reply_chars = reply.chars().count() as i64;
        t.reply = reply;
        t.blocks = std::mem::take(reply_blocks);
        turns.push(t);
    }
    reply_parts.clear();
    reply_blocks.clear();
}

/// 解析单个会话文件的完整文本
pub fn parse_session(content: &str, session_id: &str) -> SessionMeta {
    let mut turns: Vec<UserTurn> = Vec::new();
    let mut cur: Option<UserTurn> = None;
    let mut reply_parts: Vec<String> = Vec::new();
    let mut reply_blocks: Vec<ReplyBlock> = Vec::new();

    let mut cwd = String::new();
    let mut ai_title: Option<String> = None;
    let mut custom_title: Option<String> = None;
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
        // 用户 /rename 写入的自定义标题（type:"custom-title"，字段 customTitle）。
        // 可能多次重命名，不加 is_none 守卫 = 后覆盖前，取最新一次；优先级高于 ai-title。
        if obj.get("type").and_then(|v| v.as_str()) == Some("custom-title") {
            if let Some(t) = obj.get("customTitle").and_then(|v| v.as_str()) {
                if !t.is_empty() {
                    custom_title = Some(t.to_string());
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

        // 图片来源注释（可能多行/多图）：把路径挂到当前这条消息上
        let imgs = extract_image_sources(&obj);
        if !imgs.is_empty() {
            if let Some(c) = cur.as_mut() {
                c.images.extend(imgs);
            }
            continue;
        }

        // 工作中排队插话（attachment/queued_command）：算作我的一条发言
        if let Some(qp) = extract_queued_prompt(&obj) {
            flush(&mut cur, &mut reply_parts, &mut reply_blocks, &mut turns);
            if first_prompt.is_none() {
                first_prompt = Some(qp.lines().next().unwrap_or("").trim().to_string());
            }
            let ts = obj.get("timestamp").and_then(|v| v.as_str()).unwrap_or("").to_string();
            cur = Some(UserTurn {
                ts_unix: iso_to_unix(&ts),
                local_date: iso_to_local_date(&ts),
                chars: qp.chars().count() as i64,
                text: qp,
                ts,
                reply: String::new(),
                reply_chars: 0,
                blocks: Vec::new(),
                images: Vec::new(),
            });
            continue;
        }

        if let Some(ut) = extract_user_text(&obj) {
            flush(&mut cur, &mut reply_parts, &mut reply_blocks, &mut turns);
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
                blocks: Vec::new(),
                images: Vec::new(),
            });
        } else if obj.get("type").and_then(|v| v.as_str()) == Some("assistant") {
            // 收回复文字（reply 用于字数/搜索/fallback）+ 有序块（含纯工具调用事件）
            if cur.is_some() {
                if let Some(at) = extract_assistant_text(&obj) {
                    reply_parts.push(at);
                }
                reply_blocks.extend(extract_assistant_blocks(&obj));
            }
        }
    }
    flush(&mut cur, &mut reply_parts, &mut reply_blocks, &mut turns);

    let title = custom_title
        .or(ai_title)
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

/// 懒加载：在会话原文里按 tool_use_id 找对应的 tool_result，返回其文本内容。
/// tool_result 出现在某个 user 行的 message.content 数组里（与 tool_use 通过 id 配对）。
pub fn find_tool_result(content: &str, tool_use_id: &str) -> Option<String> {
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(obj) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(arr) = obj
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        else {
            continue;
        };
        for x in arr {
            if x.get("type").and_then(|v| v.as_str()) != Some("tool_result") {
                continue;
            }
            if x.get("tool_use_id").and_then(|v| v.as_str()) != Some(tool_use_id) {
                continue;
            }
            return Some(tool_result_text(x.get("content")));
        }
    }
    None
}

/// tool_result 的 content 归一成纯文本（字符串 / [{type:text,text}] 数组 / 其它原样 JSON）
fn tool_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|b| {
                if b.get("type").and_then(|v| v.as_str()) == Some("text") {
                    b.get("text").and_then(|v| v.as_str()).map(|s| s.to_string())
                } else {
                    b.as_str().map(|s| s.to_string())
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(v) => v.to_string(),
        None => String::new(),
    }
}
