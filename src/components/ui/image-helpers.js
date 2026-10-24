// Width requested from the image transform service before the wrapper has
// been measured.
export const DEFAULT_TRANSFORM_WIDTH = 800

// Class name for the preview shown while a replaced image loads: keeps the
// layout classes the element already had, falling back to the default.
export function getImagePreviewClassName(className, wrapperClassName, fallback) {
  return [className, wrapperClassName].filter(Boolean).join(" ").trim() || fallback
}
