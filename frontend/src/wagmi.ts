import { createConfig, http, injected } from "wagmi";
import { robinhoodMainnet } from "./config/contracts";

export const wagmiConfig = createConfig({
  chains: [robinhoodMainnet],
  connectors: [injected()],
  transports: {
    [robinhoodMainnet.id]: http(),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
