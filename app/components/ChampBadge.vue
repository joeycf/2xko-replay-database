<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    championId?: string | null
    /** square size in px (design: 20 related · 28 card · 30 mobile card · 38 drawer · 44 modal) */
    size?: number
    /** corner-cut notch in px */
    notch?: number
    /** override the auto (≈ size × 0.39) initials font size */
    fontSize?: number
    /** modal variant: 1.5px border at 18% white */
    strong?: boolean
  }>(),
  { championId: null, size: 28, notch: 7, fontSize: undefined, strong: false },
)

const { byId } = useChampions()
const champ = computed(() => (props.championId ? byId(props.championId) : undefined))
const initials = computed(() => (champ.value ? championInitials(champ.value) : '?'))
const style = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  background: champGradient(champ.value?.accent),
  fontSize: `${props.fontSize ?? Math.round(props.size * 0.39)}px`,
  clipPath:
    props.notch > 0
      ? `polygon(0 0, calc(100% - ${props.notch}px) 0, 100% ${props.notch}px, 100% 100%, ${props.notch}px 100%, 0 calc(100% - ${props.notch}px))`
      : undefined,
}))
</script>

<template>
  <span
    class="flex flex-none items-center justify-center font-display font-bold text-[#050607]"
    :class="strong ? 'border-[1.5px] border-white/[0.18]' : 'border border-white/[0.16]'"
    :style="style"
    :title="champ?.name"
    >{{ initials }}</span
  >
</template>
