export const themeOptions = [
  { id: "lavender", label: "Pastel Purple" },
  { id: "moonmint", label: "Moon Mint" },
  { id: "roseglass", label: "Rose Glass" },
  { id: "skyline", label: "Soft Sky" },
  { id: "peach", label: "Peach Bloom" },
  { id: "lilac", label: "Deep Lilac" },
  { id: "sage", label: "Sage Night" },
  { id: "butter", label: "Butter Glow" },
  { id: "coral", label: "Coral Dusk" },
  { id: "periwinkle", label: "Periwinkle" }
] as const;

export type ThemeId = (typeof themeOptions)[number]["id"];

export const defaultThemeId: ThemeId = "lavender";

export function isThemeId(value: string): value is ThemeId {
  return themeOptions.some((theme) => theme.id === value);
}
