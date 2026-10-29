export const THEME_KEY = "eos_theme";
export type Theme = "system" | "light" | "dark";

/**
 * Runs before first paint (inlined in the root layout) so a saved choice
 * never flashes the other theme. "system" leaves data-theme unset.
 */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
