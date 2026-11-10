const P = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export const IconFish = () => (
  <svg viewBox="0 0 24 24" {...P}><path d="M3 12c3-4.5 7.5-6 12-4l3.5-2.5v13L15 16c-4.5 2-9 .5-12-4z" /><circle cx="8" cy="11" r=".9" fill="currentColor" /></svg>
);
export const IconMap = () => (
  <svg viewBox="0 0 24 24" {...P}><path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4z" /><path d="M9 4v14M15 6v14" /></svg>
);
export const IconPin = () => (
  <svg viewBox="0 0 24 24" {...P}><path d="M12 21s-6.5-6-6.5-11A6.5 6.5 0 0 1 18.5 10c0 5-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.3" /></svg>
);
