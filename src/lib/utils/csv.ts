export function csvEscape(value: unknown) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes('"') || str.includes(",") || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function toCsv(headers: string[], rows: Array<Array<unknown>>) {
  const headerLine = headers.map(csvEscape).join(",");
  const rowLines = rows.map((row) => row.map(csvEscape).join(","));
  return [headerLine, ...rowLines].join("\n");
}