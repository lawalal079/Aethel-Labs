'use client';

import React, { useEffect, useRef } from 'react';
import { createChart, ColorType, CandlestickSeries } from 'lightweight-charts';

interface CandleData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface LightweightCandlestickChartProps {
  candles: CandleData[];
  poolName: string;
  timeframeLabel: string;
}

export default function LightweightCandlestickChart({
  candles,
  poolName,
  timeframeLabel,
}: LightweightCandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;

    // Map raw candles → strict UNIX timestamp seconds + deduplicate
    const seen = new Set<number>();
    const chartData: { time: any; open: number; high: number; low: number; close: number }[] = [];

    candles
      .map((c) => ({
        time: Math.floor(new Date(c.timestamp).getTime() / 1000) as any,
        open: parseFloat(String(c.open)),
        high: parseFloat(String(c.high)),
        low: parseFloat(String(c.low)),
        close: parseFloat(String(c.close)),
      }))
      .sort((a, b) => a.time - b.time)
      .forEach((item) => {
        if (!seen.has(item.time)) {
          seen.add(item.time);
          chartData.push(item);
        }
      });

    const chart = createChart(container, {
      width: container.clientWidth,
      height: 320,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#8a8f98',
      },
      grid: {
        vertLines: { color: '#1F2225', style: 2 },
        horzLines: { color: '#1F2225', style: 2 },
      },
      crosshair: {
        mode: 1,
        vertLine: { color: '#4E8981', width: 1, style: 3 },
        horzLine: { color: '#4E8981', width: 1, style: 3 },
      },
      rightPriceScale: {
        borderColor: '#2A2F35',
      },
      timeScale: {
        borderColor: '#2A2F35',
        timeVisible: true,
        secondsVisible: false,
      },
    });

    // fitContent() auto-scales the horizontal timeline across all loaded candles
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#10B981',
      downColor: '#F43F5E',
      borderVisible: false,
      wickUpColor: '#10B981',
      wickDownColor: '#F43F5E',
    });

    series.setData(chartData);
    chart.timeScale().fitContent();

    const handleResize = () => {
      chart.applyOptions({ width: container.clientWidth });
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, [candles]);

  return (
    <div className="w-full h-[320px] relative">
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}
