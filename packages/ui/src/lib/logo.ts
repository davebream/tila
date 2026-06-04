const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="410 850 470 360" fill="currentColor"><path d="M701.628 860.994c22.092 12.302 45.529 26.971 67.251 40.057l102.365 61.261-169.513 101.118c-5.174-3.48-11.495-7.04-16.931-10.19-51.113-29.59-101.25-61.552-152.585-90.705z"/><path d="M564.739 1064.82c8.501 3.1 36.108 20.2 44.739 25.37a4954 4954 0 0 0 92.542 55.13c45.148-25.79 90.945-54.1 135.923-80.64q16.508 9.795 33.132 19.41a2422 2422 0 0 0-31.614 18.97 11044 11044 0 0 1-137.666 82.46c-55.938-33.31-113.522-68.96-169.664-101.32 10.417-5.66 22.305-13.18 32.608-19.38"/><path d="M565.263 1003.95c3.541 1.13 11.511 6.52 15.284 8.67 40.739 23.25 80.465 49.57 121.697 71.84 14.102-7.39 33.592-19.71 47.523-28.03l87.793-52.52q16.898 9.765 33.674 19.74c-9.91 6.4-22.41 13.34-32.734 19.41a11108 11108 0 0 1-136.6 81.56c-56.464-31.44-113.388-68.71-170.026-101 11.054-6.06 22.506-13.16 33.389-19.67"/></svg>`;

export function createLogoSvg(size: number): SVGSVGElement {
  const container = document.createElement("div");
  container.innerHTML = SVG;
  const svg = container.firstElementChild as SVGSVGElement;
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.removeAttribute("xmlns");
  return svg;
}
