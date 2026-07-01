export const STATUS_COLORS: Record<string, string> = {
  "todo": "#6b7280",
  "in-progress": "#3b82f6",
  "blocked": "#ef4444",
  "review": "#8b5cf6",
  "done": "#22c55e",
  "cancelled": "#9ca3af",
};

export const PRIORITY_COLORS: Record<string, string> = {
  "critical": "#ef4444",
  "high": "#f97316",
  "medium": "#eab308",
  "low": "#22c55e",
};

export const STATUS_LABELS: Record<string, string> = {
  "todo": "To Do",
  "in-progress": "In Progress",
  "blocked": "Blocked",
  "review": "Review",
  "done": "Done",
  "cancelled": "Cancelled",
};

export const PRIORITY_LABELS: Record<string, string> = {
  "": "None",
  "critical": "Critical",
  "high": "High",
  "medium": "Medium",
  "low": "Low",
};

export function getStatusColor(status: string): string {
  return STATUS_COLORS[status] ?? "#6b7280";
}

export function getPriorityColor(priority: string | undefined): string {
  return priority ? (PRIORITY_COLORS[priority] ?? "") : "";
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function stripWikiLinks(str: string): string {
  return str.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, page, display) => display?.trim() ?? page.trim());
}

export function withAlpha(hex: string, alphaHex: string): string {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  const expanded = h.length === 3 ? h[0]+h[0]+h[1]+h[1]+h[2]+h[2] : h;
  return `#${expanded}${alphaHex}`;
}
