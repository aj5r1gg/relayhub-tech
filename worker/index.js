import { routeRequest } from "./src/router.js";

export default {
  async fetch(request, env) {
    return routeRequest(request, env);
  },
};