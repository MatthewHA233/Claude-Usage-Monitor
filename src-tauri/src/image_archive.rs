//! 图片归档：把 Claude JSONL 内嵌的 base64 图片解码 → 缩放 + 重编码压缩 → 落盘到
//! `<LocalAppData>/claude-usage-monitor/image-archive/<hash>.<ext>`，按内容 hash 去重（只增）。
//!
//! 物化时调用，取代易被 Claude 清理的 image-cache 临时副本路径 → 预览永久不丢（本机/远程通用：
//! 远程 base64 随 JSONL 原字节经中继传来，同样在本机归档）。

use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD, Engine};
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, ExtendedColorType, ImageEncoder};
use sha2::{Digest, Sha256};

const MAX_DIM: u32 = 1600; // 最长边超过即等比缩小（预览够用、省空间——缩放是省空间的大头）
const JPEG_QUALITY: u8 = 85; // 不透明图用 JPEG 此质量（截图肉眼基本无损）

fn archive_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join("claude-usage-monitor").join("image-archive"))
}

/// 归档一张 base64 图，返回归档文件绝对路径；空/解码/写盘失败返回 None。
/// 同内容只处理一次（hash 去重）：已存在直接返回，不重复解码压缩。
pub fn archive_b64(data_b64: &str) -> Option<String> {
    let dir = archive_dir()?;
    let data = data_b64.trim();
    if data.is_empty() {
        return None;
    }
    // 内容 hash（基于原始 base64 文本，稳定、跨次运行一致）→ 文件名
    let mut hasher = Sha256::new();
    hasher.update(data.as_bytes());
    let full = format!("{:x}", hasher.finalize());
    let stem = &full[..32];
    // 已归档（任一扩展名）→ 直接返回，跳过昂贵的解码/缩放/编码
    for ext in ["jpg", "png"] {
        let p = dir.join(format!("{stem}.{ext}"));
        if p.exists() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    // 解码 base64 → 图片
    let bytes = STANDARD.decode(data).ok()?;
    let img = image::load_from_memory(&bytes).ok()?;
    // 超框等比缩小（resize 保持长宽比、缩到 MAX_DIM×MAX_DIM 框内）
    let img = if img.width() > MAX_DIM || img.height() > MAX_DIM {
        img.resize(MAX_DIM, MAX_DIM, FilterType::Triangle)
    } else {
        img
    };
    std::fs::create_dir_all(&dir).ok()?;
    // 截图多为 RGBA 但实际全不透明：只看格式 has_alpha() 会全走 PNG、丢掉 JPEG 压缩。
    // 故真扫一遍 alpha——存在半透明/透明像素才留 PNG，否则一律 JPEG 压。
    let keep_png = img.color().has_alpha() && img.to_rgba8().pixels().any(|p| p[3] < 250);
    if keep_png {
        let p = dir.join(format!("{stem}.png"));
        img.save(&p).ok()?;
        Some(p.to_string_lossy().into_owned())
    } else {
        let p = dir.join(format!("{stem}.jpg"));
        let rgb = img.to_rgb8();
        let mut buf = Vec::new();
        JpegEncoder::new_with_quality(&mut buf, JPEG_QUALITY)
            .write_image(rgb.as_raw(), rgb.width(), rgb.height(), ExtendedColorType::Rgb8)
            .ok()?;
        std::fs::write(&p, &buf).ok()?;
        Some(p.to_string_lossy().into_owned())
    }
}
