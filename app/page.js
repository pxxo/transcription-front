"use client";
import React, { useState, useRef } from "react";
import Image from "next/image";

export default function Home() {
  const [file, setFile] = useState(null);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [elapsed, setElapsed] = useState(null);
  const abortRef = useRef(null);

  const handleFileChange = (e) => {
    setFile(e.target.files[0]);
    setResults([]);
    setError("");
    setProgress(0);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file) return;
    setLoading(true);
    setResults([]);
    setError("");
    setProgress(0);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("http://localhost:5000/transcribe", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });
      if (!res.body) throw new Error("ストリーム未対応");
      const reader = res.body.getReader();
      let decoder = new TextDecoder();
      let buffer = "";
      let allResults = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let lines = buffer.split("\n");
        buffer = lines.pop(); // 最後は未完了の可能性
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.result) {
              allResults.push(data.result);
              setResults([...allResults]);
            }
            if (typeof data.progress === "number") {
              setProgress(data.progress);
            }
            if (data.done && typeof data.elapsed === "number") {
              setElapsed(data.elapsed);
            }
          } catch (e) {
            // JSONパース失敗は無視
          }
        }
      }
      setProgress(1);
    } catch (err) {
      if (err.name !== "AbortError") {
        setError("API通信エラー: " + err.message);
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
          accept="audio/*"
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
        <div className="w-full max-w-xl mt-4">
          <div className="h-6 bg-gray-200 rounded">
            <div
              className="h-6 bg-blue-500 rounded flex items-center justify-center min-w-fit"
              style={{ width: `${Math.round(progress * 100)}%`, transition: "width 0.2s" }}
            >
              <div className="text-xs text-gray-600 mt-1">進捗: {Math.round(progress * 100)}%</div>
            </div>
          </div>
        </div>
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
