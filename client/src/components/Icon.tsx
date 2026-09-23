const PATHS: Record<string, string> = {
  play: "M7 4.5v15l12-7.5z",
  pause: "M7 4h4v16H7zM13 4h4v16h-4z",
  reset: "M4 12a8 8 0 1 0 2.35-5.65M4 4v4h4",
  grid: "M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18",
  trail: "M4 19c3-8 7-11 16-14M18 5l2 0 0 2",
  vector: "M4 20L19 5M12 5h7v7",
  label: "M4 6h16v9H13l-4 4v-4H4z",
  axes: "M5 19V5M5 19h14M5 19l9-9",
  follow: "M12 3v4M12 17v4M3 12h4M17 12h4M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
  frame: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5",
  sphere: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M3 12c3 2.5 15 2.5 18 0",
  box: "M4 7l8-4 8 4v10l-8 4-8-4zM4 7l8 4 8-4M12 11v10",
  cylinder: "M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3v12c0 1.7-3.1 3-7 3s-7-1.3-7-3zM5 6c0 1.7 3.1 3 7 3s7-1.3 7-3",
  ramp: "M3 19h18L3 7z",
  plate: "M2 14l10-5 10 5-10 5zM2 14v2l10 5 10-5v-2",
  move: "M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  share: "M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.6 13.5l6.8 4M15.4 6.5l-6.8 4",
  download: "M12 3v12M7 10l5 5 5-5M4 20h16",
  library: "M4 4h4v16H4zM10 4h4v16h-4zM16 5l3.5-1 2.5 15.5-3.5 1z",
  sun: "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  send: "M4 12l16-8-6 16-2.5-6.5z",
  sparkle: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  check: "M5 12.5l4.5 4.5L19 7",
  warning: "M12 3l10 18H2zM12 10v5M12 18v.5",
  error: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v6M12 16v.5",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5v.5",
  chevron: "M9 6l6 6-6 6",
  close: "M6 6l12 12M18 6L6 18",
  compare: "M4 4h7v16H4zM13 4h7v16h-7z",
  history: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 3",
  chart: "M4 20V4M4 20h16M7 15l4-5 3 3 5-7",
  sliders: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
  stats: "M5 20V10M12 20V4M19 20v-7",
  chat: "M4 5h16v11H9l-5 4z",
  scene: "M12 2l9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10",
  save: "M5 3h11l3 3v15H5zM8 3v6h7V3M8 21v-7h8v7",
  upload: "M12 21V9M7 14l5-5 5 5M4 4h16",
  loop: "M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4",
  camera: "M4 8h3l2-3h6l2 3h3v11H4zM12 11a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  plus: "M12 5v14M5 12h14",
  zoomIn: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M11 8v6M8 11h6",
  zoomOut: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M8 11h6",
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, title }: { name: IconName; size?: number; title?: string }) {
  const filled = name === "play" || name === "pause" || name === "send";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="icon"
    >
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  );
}
