import { network } from "hardhat";

export const utils = {
  time: {
    setBlockTimestamp: async (timestamp: number): Promise<void> => {
      await network.provider.send("evm_mine", [timestamp]);
    },

    increaseTime: async (seconds: number): Promise<void> => {
      await network.provider.send("evm_increaseTime", [seconds]);
      await network.provider.send("evm_mine", []);
    }
  },

  block: {
    mine: async (count: number = 1): Promise<void> => {
      for(let i = 0; i < count; i++) {
        await network.provider.send("evm_mine", []);
      }
    }
  },

  account: {
    setBalance: async (address: string, balance: number): Promise<void> => {
      await network.provider.send("hardhat_setBalance", [address, balance.toString()]);
    }
  }
} as const;

export const { time, block, account } = utils;