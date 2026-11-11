import { handleDeadDeals } from "./api.js";

export default {
  fetch(request, env) {
    return handleDeadDeals(request, env);
  },
};
