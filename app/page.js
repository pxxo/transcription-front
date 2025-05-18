"use client";
import React, { useState, useRef } from "react";
import { Document, Packer, Paragraph, TextRun } from "docx";

export default function Home() {
  const [file, setFile] = useState(null);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [elapsed, setElapsed] = useState(null);
  const [currentSegment, setCurrentSegment] = useState(0);
  const [totalSegments, setTotalSegments] = useState(0);
  const [wordBlob, setWordBlob] = useState(null);
  const abortRef = useRef(null);

  const handleFileChange = (e) => {
    setFile(e.target.files[0]);
    setResults([]);
    setError("");
    setProgress(0);
    setCurrentSegment(0);
    setTotalSegments(0);
  };

  const splitAudioFile = async (file) => {
    // 1. ファイルをArrayBufferで読み込む
    const arrayBuffer = await file.arrayBuffer();
    // 2. AudioContextでデコード
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    const duration = audioBuffer.duration;
    const segmentLength = 60; // 60秒ごと
    const segments = Math.ceil(duration / segmentLength);
    setTotalSegments(segments);

    // WAVエンコード関数
    function encodeWAV(audioBuffer) {
      const numChannels = audioBuffer.numberOfChannels;
      const sampleRate = audioBuffer.sampleRate;
      const format = 1; // PCM
      const bitDepth = 16;
      const samples = audioBuffer.length;
      const buffer = new ArrayBuffer(44 + samples * numChannels * 2);
      const view = new DataView(buffer);
      // RIFF identifier
      writeString(view, 0, 'RIFF');
      view.setUint32(4, 36 + samples * numChannels * 2, true);
      writeString(view, 8, 'WAVE');
      writeString(view, 12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, format, true);
      view.setUint16(22, numChannels, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * numChannels * 2, true);
      view.setUint16(32, numChannels * 2, true);
      view.setUint16(34, bitDepth, true);
      writeString(view, 36, 'data');
      view.setUint32(40, samples * numChannels * 2, true);
      // PCM samples
      let offset = 44;
      for (let i = 0; i < samples; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
          let sample = audioBuffer.getChannelData(ch)[i];
          sample = Math.max(-1, Math.min(1, sample));
          view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
          offset += 2;
        }
      }
      return new Blob([buffer], { type: 'audio/wav' });
    }
    function writeString(view, offset, string) {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    }

    // 3. 分割処理
    const segmentFiles = [];
    for (let i = 0; i < segments; i++) {
      const start = i * segmentLength;
      const end = Math.min((i + 1) * segmentLength, duration);
      const segmentDuration = end - start;
      // 新しいAudioBufferを作成
      const segmentBuffer = audioContext.createBuffer(
        audioBuffer.numberOfChannels,
        Math.floor(segmentDuration * audioBuffer.sampleRate),
        audioBuffer.sampleRate
      );
      for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
        const channel = audioBuffer.getChannelData(ch).slice(
          Math.floor(start * audioBuffer.sampleRate),
          Math.floor(end * audioBuffer.sampleRate)
        );
        segmentBuffer.copyToChannel(channel, ch, 0);
      }
      // WAVにエンコード
      const blob = encodeWAV(segmentBuffer);
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
      // Word生成用のBlobをセット
      setWordBlob({ ready: true });
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

  const handleDownloadWord = () => {
    if (!results.length) return;
    // 各文ごとにParagraphを作成し、Word上で改行されるようにする
    const doc = new Document({
      sections: [
        {
          properties: {},
          children: results.map(item =>
            new Paragraph({
              children: [
                new TextRun({
                  text: item.text,
                  size: 24,
                })
              ]
            })
          )
        }
      ]
    });
    Packer.toBlob(doc).then(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = (file?.name || "transcription") + ".docx";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);
    });
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
      {wordBlob && results.length > 0 && (
        <button
          className="bg-green-600 text-white px-4 py-2 rounded mt-2"
          onClick={handleDownloadWord}
        >
          Wordファイルをダウンロード
        </button>
      )}
    </div>
  );
}
