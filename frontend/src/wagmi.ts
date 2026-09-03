import { createConfig, http, injected } from "wagmi";
import { robinhoodTestnet } from "./config/contracts";

export const wagmiConfig = createConfig({
  chains: [robinhoodTestnet],
  connectors: [injected()],
  transports: {
    [robinhoodTestnet.id]: http(),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
