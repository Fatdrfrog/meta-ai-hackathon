// Which of the ad studio's v2 tools the page shows. Each is one line, so a
// late cut (the owner's order: Describe a place first, then Earlier
// pictures) changes the page without touching its code. The API keeps
// answering every tool: a hidden one is only a control the page leaves out.

/** "New picture" on a scene, with the 5 tested places: the only paid press. */
export const AD_SCENE_TOOLS = true;

/** "Describe a place": the owner's own place, read by Muse Spark. Needs AD_SCENE_TOOLS. */
export const AD_DESCRIBE_PLACE = true;

/** "Earlier pictures": a scene's kept Muse Image pictures, picked again for free. */
export const AD_EARLIER_PICTURES = true;
