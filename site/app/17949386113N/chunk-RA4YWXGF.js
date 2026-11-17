// ../games/spacepoker/ui/formatting.ts
var TRILLION = 1000000000000n;
function formatSpacepokerAmount(mojos) {
  if (mojos < 1000000n) return `${mojos} MOJO`;
  const whole = mojos / TRILLION;
  const frac = mojos % TRILLION;
  if (frac === 0n) return `${whole} XCH`;
  return `${whole}.${frac.toString().padStart(12, "0").replace(/0+$/, "")} XCH`;
}
function formatSpacepokerMojos(mojos) {
  const abs = mojos < 0n ? -mojos : mojos;
  if (abs < 100000000n) return `${mojos.toLocaleString()} mojos`;
  const sign = mojos < 0n ? "-" : "";
  const whole = abs / TRILLION;
  const frac = (abs % TRILLION).toString().padStart(12, "0").slice(0, 4);
  return `${sign}${whole.toLocaleString()}.${frac} XCH`;
}
function formatSpacepokerXch(mojos) {
  const sign = mojos < 0n ? "-" : "";
  const abs = mojos < 0n ? -mojos : mojos;
  const s = abs.toString().padStart(13, "0");
  const whole = s.slice(0, -12).replace(/^0+/, "") || "0";
  const frac = s.slice(-12).replace(/0+$/, "");
  return `${sign}${frac ? `${whole}.${frac}` : whole} XCH`;
}

export {
  formatSpacepokerAmount,
  formatSpacepokerMojos,
  formatSpacepokerXch
};
