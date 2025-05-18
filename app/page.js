"use client";
import React, { useState, useRef } from "react";
import Image from "next/image";
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL, fetchFile } from '@ffmpeg/util';

export default function Home() {
  const [file, setFile] = useState(null);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [elapsed, setElapsed] = useState(null);
  const [currentSegment, setCurrentSegment] = useState(0);
  const [totalSegments, setTotalSegments] = useState(0);
  const abortRef = useRef(null);
  const ffmpegRef = useRef(null);

  const handleFileChange = (e) => {
    setFile(e.target.files[0]);
    setResults([]);
    setError("");
    setProgress(0);
    setCurrentSegment(0);
    setTotalSegments(0);
  };

  const loadFFmpeg = async () => {
    if (ffmpegRef.current) return ffmpegRef.current;

    const ffmpeg = new FFmpeg();
    await ffmpeg.load({
      coreURL: await toBlobURL('/ffmpeg-core.js', 'text/javascript'),
      wasmURL: await toBlobURL('/ffmpeg-core.wasm', 'application/wasm'),
    });
    ffmpegRef.current = ffmpeg;
    return ffmpeg;
  };

  const splitAudioFile = async (file) => {
    const ffmpeg = await loadFFmpeg();
    const inputFileName = 'input.' + file.name.split('.').pop();
    await ffmpeg.writeFile(inputFileName, await fetchFile(file));

    // Get duration
    await ffmpeg.exec(['-i', inputFileName]);
    const output = await ffmpeg.readStderr();
    const durationMatch = output.match(/Duration: (\d{2}):(\d{2}):(\d{2})/);
    if (!durationMatch) throw new Error('Cannot get file duration');

    const hours = parseInt(durationMatch[1]);
    const minutes = parseInt(durationMatch[2]);
    const seconds = parseInt(durationMatch[3]);
    const totalSeconds = hours * 3600 + minutes * 60 + seconds;
    const segments = Math.ceil(totalSeconds / 60);
    setTotalSegments(segments);

    const segmentFiles = [];
    for (let i = 0; i < segments; i++) {
      const outputFileName = `segment_${i}.wav`;
      await ffmpeg.exec([
        '-i', inputFileName,
        '-ss', `${i * 60}`,
        '-t', '60',
        '-ac', '1',
        '-ar', '16000',
        outputFileName
      ]);
      const data = await ffmpeg.readFile(outputFileName);
      const blob = new Blob([data], { type: 'audio/wav' });
      segmentFiles.push(blob);
    }
    return segmentFiles;
  };

  const transcribeSegment = async (blob, segmentIndex, totalSegments) => {
    const formData = new FormData();
    formData.append("file", blob, "segment.wav");
    const res = await fetch("https://oktn-dev.com/api/transcribe", {
      method: "POST",
      body: formData,
      signal: abortRef.current?.signal,
    });

    if (!res.body) throw new Error("ストリーム未対応");
    const reader = res.body.getReader();
    let decoder = new TextDecoder();
    let buffer = "";
    let segmentResults = [];

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.result) {
            const adjustedResult = {
              ...data.result,
              start: data.result.start + segmentIndex * 60,
              end: data.result.end + segmentIndex * 60,
            };
            segmentResults.push(adjustedResult);
            setResults(prevResults => [...prevResults, adjustedResult]);
          }
          if (typeof data.progress === "number") {
            const overallProgress = (segmentIndex + data.progress) / totalSegments;
            setProgress(overallProgress);
          }
        } catch (e) {
          console.error("JSON parse error:", e);
        }
      }
    }
    return segmentResults;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file) return;
    setLoading(true);
    setResults([]);
    setError("");
    setProgress(0);
    setCurrentSegment(0);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const segments = await splitAudioFile(file);
      let allResults = [];
      let totalTime = 0;

      for (let i = 0; i < segments.length; i++) {
        if (abortRef.current?.signal.aborted) break;
        setCurrentSegment(i + 1);
        const segmentResults = await transcribeSegment(segments[i], i, segments.length);
        allResults = [...allResults, ...segmentResults];
      }

      setProgress(1);
      setElapsed(totalTime);
    } catch (err) {
      if (err.name !== "AbortError") {
        setError("API通信エラー: " + err.message);
        console.error(err);
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  };

  const handleAbort = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-8 gap-8">
      <h1 className="text-2xl font-bold mb-4">音声→テキスト（Whisper+MeCab）デモ</h1>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 items-center">
        <input
          type="file"
          accept=".m4a,.mp3,.wav,audio/*"
          onChange={handleFileChange}
          className="border p-2 rounded"
        />
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={!file || loading}
            className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
          >
            {loading ? "送信中..." : "音声を送信"}
          </button>
          {loading && (
            <button
              type="button"
              onClick={handleAbort}
              className="bg-gray-400 text-white px-4 py-2 rounded"
            >
              中止
            </button>
          )}
        </div>
      </form>
      {loading && (
        <>
          <div className="w-full max-w-xl mt-4">
            <div className="text-sm text-gray-600 mb-2">
              セグメント {currentSegment}/{totalSegments} を処理中
            </div>
            <div className="h-6 bg-gray-200 rounded">
              <div
                className="h-6 bg-blue-500 rounded flex items-center justify-center min-w-fit"
                style={{ width: `${Math.round(progress * 100)}%`, transition: "width 0.2s" }}
              >
                <div className="text-xs text-gray-600 mt-1">
                  進捗: {Math.round(progress * 100)}%
                </div>
              </div>
            </div>
          </div>
        </>
      )}
      {error && <div className="text-red-600">{error}</div>}
      <div className="w-full max-w-xl mt-6">
        {results.length > 0 && (
          <ol className="space-y-4">
            {results.map((item, idx) => (
              <li key={idx} className="bg-gray-100 p-3 rounded shadow">
                <div className="text-xs text-gray-500 mb-1">
                  [{item.start.toFixed(2)}s - {item.end.toFixed(2)}s]
                </div>
                <div className="text-base whitespace-pre-line">{item.text}</div>
              </li>
            ))}
          </ol>
        )}
      </div>
      {elapsed !== null && (
        <div className="text-green-700 font-bold mt-4">
          処理時間: {elapsed.toFixed(2)} 秒
        </div>
      )}
    </div>
  );
}
