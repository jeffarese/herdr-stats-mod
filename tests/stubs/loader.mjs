// Maps the host's bare module names to the in-memory stubs beside this file.
import { register } from "node:module";

register(new URL("./hooks.mjs", import.meta.url));
