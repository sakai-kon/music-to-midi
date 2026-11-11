# Hero section design notes

This hero redesign is the first visual layer of Music to MIDI. It keeps the existing conversion workflow below the fold and introduces a product-style introduction above it.

## Visual direction

- **Minimal canvas:** white page, restrained monochrome controls and generous whitespace.
- **Typography first:** a large, tightly tracked Japanese headline with a soft indigo gradient only on the second line.
- **Single accent:** muted periwinkle is reserved for the hero headline and the sound-to-MIDI illustration.
- **Product visual:** a dark rounded panel uses inline SVG to show a waveform becoming MIDI notes. It is vector artwork, so it stays crisp at all screen sizes and needs no image request.
- **Quiet surfaces:** the file workspace and settings use soft neutral backgrounds, large radii and subtle shadows instead of heavy borders.

## Interaction

- The primary hero action opens the existing file picker; there is no duplicate upload flow.
- The secondary action scrolls to the existing upload and settings section.
- Hero and proof-point elements reveal on scroll using IntersectionObserver.
- Buttons and cards use a restrained `cubic-bezier(.25, 1, .5, 1)` easing curve.
- `prefers-reduced-motion` disables decorative movement and keeps content visible.
- Keyboard focus remains visible and the hero artwork has an accessible text description.

## Responsive behavior

- Desktop: copy and illustration sit side-by-side in a balanced two-column layout.
- Tablet: the same hierarchy is retained with reduced type and illustration scale.
- Mobile: the hero becomes a single column, the artwork moves below the call to action and the proof points become compact columns.
- At narrow widths, padding and heading size reduce without clipping the SVG.

## Implementation

- `index.html`: semantic hero content and SVG artwork.
- `src/style.css`: design tokens, layout, responsive states, transitions and keyframes.
- `src/main.js`: hero file-picker action and accessible scroll reveal.

The implementation intentionally uses plain HTML, CSS and JavaScript; no large UI framework is needed for this section.