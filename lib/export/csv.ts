/**
 * CSV downloads (opened / not-opened exports). Excel-friendly: a UTF-8 BOM so names in any
 * script open correctly, CRLF line ends, and every cell quoted. Cells that start with = + - @
 * (or a tab/CR) get a leading apostrophe so a recruiter's name can't run as a spreadsheet formula.
 */
import { NextResponse } from 'next/server';

export type CsvValue = string | number | boolean | Date | null | undefined;

const IST = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });

/** "11 Nov 2026, 06:26 pm" in IST, or "" when there is no date. */
export function istDateTime(d: Date | null | undefined): string {
  return d ? IST.format(d) : '';
}

export function csvCell(value: CsvValue): string {
  let s = value instanceof Date ? istDateTime(value) : value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(headers: string[], rows: CsvValue[][]): string {
  return '﻿' + [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** A safe file name from a send's name: "Dec Drive Invite - opened.csv". */
export function csvFileName(name: string, suffix: string): string {
  const base = name.replace(/[^\p{L}\p{N} ._-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'export';
  return `${base} - ${suffix}.csv`;
}

export function csvResponse(body: string, fileName: string): NextResponse {
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fileName.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Cache-Control': 'no-store',
    },
  });
}

export type OpenFilter = 'all' | 'opened' | 'not_opened';
export function parseOpenFilter(v: string | null): OpenFilter {
  return v === 'opened' || v === 'not_opened' ? v : 'all';
}
export const FILTER_LABEL: Record<OpenFilter, string> = { all: 'all', opened: 'opened', not_opened: 'not opened' };
