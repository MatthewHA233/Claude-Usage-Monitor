import { useCallback, useEffect, useRef, useState } from "react";
import alarmSoundUrl from "../assets/alarm.mp3";
import type { UsageSnapshot } from "../types";

const STORAGE_KEY = "session_alarm_enabled_aliases";
const TRIGGER_WINDOW_MS = 2 * 60 * 1000; // reset 时刻起 2 分钟内可触发
const MERGE_WINDOW_MS = 60 * 1000;       // ±1 分钟合并
const TICK_MS = 1000;

function loadEnabled(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.map(String)) : new Set();
  } catch {
    return new Set();
  }
}

function saveEnabled(set: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch { /* ignore */ }
}

interface AlarmAPI {
  isEnabled: (alias: string) => boolean;
  toggle: (alias: string) => void;
  ringingAliases: string[];
  stopAll: () => void;
}

export function useResetAlarm(snapshots: UsageSnapshot[]): AlarmAPI {
  const [enabled, setEnabled] = useState<Set<string>>(() => loadEnabled());
  const [ringingAliases, setRingingAliases] = useState<string[]>([]);

  const consumedRef = useRef<Set<string>>(new Set());
  const activeKeysRef = useRef<string[]>([]);
  const activeTriggerTimeRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const enabledRef = useRef(enabled);
  const snapshotsRef = useRef(snapshots);

  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => { snapshotsRef.current = snapshots; }, [snapshots]);

  useEffect(() => {
    const audio = new Audio(alarmSoundUrl);
    audio.loop = true;
    audio.preload = "auto";
    audioRef.current = audio;
    return () => {
      audio.pause();
      audioRef.current = null;
    };
  }, []);

  const stopAll = useCallback(() => {
    const a = audioRef.current;
    if (a) { a.pause(); a.currentTime = 0; }
    for (const k of activeKeysRef.current) consumedRef.current.add(k);
    activeKeysRef.current = [];
    activeTriggerTimeRef.current = null;
    setRingingAliases([]);
  }, []);

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      const en = enabledRef.current;
      const snaps = snapshotsRef.current;
      if (en.size === 0) return;

      let triggerTime = activeTriggerTimeRef.current;
      const newKeys: string[] = [];
      const newAliases: string[] = [];

      for (const snap of snaps) {
        if (!en.has(snap.account_alias)) continue;
        const ra = snap.session_reset_at;
        if (!ra) continue;
        const t = new Date(ra).getTime();
        if (Number.isNaN(t)) continue;
        const diff = now - t;
        if (diff < 0 || diff > TRIGGER_WINDOW_MS) continue;
        const key = `${snap.account_alias}|${ra}`;
        if (consumedRef.current.has(key)) continue;
        if (activeKeysRef.current.includes(key)) continue;
        if (triggerTime == null) {
          triggerTime = t;
          newKeys.push(key);
          newAliases.push(snap.account_alias);
        } else if (Math.abs(t - triggerTime) <= MERGE_WINDOW_MS) {
          newKeys.push(key);
          newAliases.push(snap.account_alias);
        }
      }

      if (newKeys.length === 0) return;
      const wasIdle = activeKeysRef.current.length === 0;
      activeKeysRef.current = [...activeKeysRef.current, ...newKeys];
      activeTriggerTimeRef.current = triggerTime;
      setRingingAliases(prev => [...prev, ...newAliases]);
      if (wasIdle) {
        const a = audioRef.current;
        if (a) {
          a.currentTime = 0;
          void a.play().catch(() => { /* 自动播放策略可能阻塞 */ });
        }
      }
    };

    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, []);

  const isEnabled = useCallback((alias: string) => enabled.has(alias), [enabled]);

  const toggle = useCallback((alias: string) => {
    setEnabled(prev => {
      const next = new Set(prev);
      if (next.has(alias)) next.delete(alias);
      else next.add(alias);
      saveEnabled(next);
      return next;
    });
  }, []);

  return { isEnabled, toggle, ringingAliases, stopAll };
}
