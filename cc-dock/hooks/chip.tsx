import type { ClientModule } from 'claude-code'

// A coloured `[ label ]` chip whose word and brackets share one colour (a Button cannot). While lit, a
// highlight sweeps across the letters, the shimmer Claude Code gives the word "ultracode". A click
// posts `{ press: true }`.
export type ChipProps = { label: string; color: string; glow?: string; lit: boolean; width?: number; bracketColor?: string }
type ChipState = { frame: number }

const Chip: ClientModule<ChipProps, ChipState> = (props, surface) => {
  const { Box, Text } = surface.elements
  const state = surface.state ?? { frame: 0 }
  const span = props.label.length + 6 // the sweep runs off both ends before it comes round
  if (surface.state === undefined) {
    surface.setState({ frame: 0 })
    surface.every(90, () => {
      const s = surface.state ?? { frame: 0 }
      surface.setState({ frame: (s.frame + 1) % span })
    })
    surface.onPointer(event => {
      if (event.type === 'down') surface.post({ press: true })
    })
  }
  const glow = props.glow ?? props.color
  const head = state.frame - 3
  // Centred to `width` when given, so the chip lines up with bracket buttons beside it.
  const pad = Math.max(0, (props.width ?? props.label.length) - props.label.length)
  const padL = ' '.repeat(Math.floor(pad / 2))
  const padR = ' '.repeat(pad - Math.floor(pad / 2))
  const letters = props.lit
    ? [...props.label].map((ch, i) => {
        const d = Math.abs(i - head)
        // The letter under the sweep glows, its two neighbours a little, the rest hold the base colour.
        return <Text key={`c${i}`} bold color={d === 0 ? glow : props.color} dimColor={false}>{ch}</Text>
      })
    : [<Text key="w" dimColor>{props.label}</Text>]
  return (
    <Box flexDirection="row">
      <Text bold={props.lit} color={props.lit ? props.bracketColor ?? props.color : undefined} dimColor={!props.lit}>{`[ ${padL}`}</Text>
      {letters}
      <Text bold={props.lit} color={props.lit ? props.bracketColor ?? props.color : undefined} dimColor={!props.lit}>{`${padR} ]`}</Text>
    </Box>
  )
}

export default Chip
