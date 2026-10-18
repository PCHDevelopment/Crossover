// Entry point: the routes the service exposes.
import "./auth.js";
import { routes } from "./routes.js";

export const routeNames = [...routes.keys()];
