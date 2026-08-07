/**
 * On-chain contract queries (ValidatorSet, SlashIndicator, StakeHub)
 * Ported from getchainstatus.js
 */

import { ethers } from "ethers";

const ADDR_VALIDATOR_SET = "0x0000000000000000000000000000000000001000";
const ADDR_SLASH         = "0x0000000000000000000000000000000000001001";
const ADDR_STAKE_HUB     = "0x0000000000000000000000000000000000002002";

const validatorSetAbi = [
  "function getLivingValidators() external view returns (address[], bytes[])",
  "function getValidators() external view returns (address[])",
  "function getMiningValidators() external view returns (address[])",
  "function turnLength() external view returns (uint256)",
  "function numOfCabinets() external view returns (uint256)",
  "function systemRewardAntiMEVRatio() external view returns (uint256)",
];

const slashAbi = [
  "function getSlashIndicator(address validatorAddr) external view returns (uint256, uint256)",
  "function misdemeanorThreshold() external view returns (uint256)",
  "function felonyThreshold() external view returns (uint256)",
];

const stakeHubAbi = [
  "function getValidatorElectionInfo(uint256 offset, uint256 limit) external view returns (address[], uint256[], bytes[], uint256)",
  "function getValidatorDescription(address validatorAddr) external view returns (tuple(string, string, string, string))",
  "function consensusToOperator(address consensusAddr) public view returns (address)",
  "function maxElectedValidators() public view returns (uint256)",
];

export class ChainContracts {
  constructor(provider) {
    this.provider    = provider;
    this.validatorSet = new ethers.Contract(ADDR_VALIDATOR_SET, validatorSetAbi, provider);
    this.slash        = new ethers.Contract(ADDR_SLASH, slashAbi, provider);
    this.stakeHub     = new ethers.Contract(ADDR_STAKE_HUB, stakeHubAbi, provider);
  }

  async getLivingValidators() {
    const [addrs] = await this.validatorSet.getLivingValidators();
    return addrs;
  }

  async getTurnLength() {
    return Number(await this.validatorSet.turnLength());
  }

  // Validator tiers:cabinet = getValidators() 按权重排序的前 numOfCabinets 名(稳定身份),
  // candidate = 当选但排在名额之外(靠 shuffle 偶尔轮值出块), 其余 inactive。
  // 注意:不能用 getMiningValidators() 判身份 —— 那是每 epoch shuffle 后的临时出块集
  // (最多 maxNumOfWorkingCandidates 个候补被换入、同数量 cabinet 轮空),会让 tier 在 CAB/CAND 间来回跳。
  async getValidatorTiers() {
    const [elected, numCabRaw] = await Promise.all([
      this.validatorSet.getValidators(),
      this.validatorSet.numOfCabinets().catch(() => 0n),
    ]);
    const numCab = Number(numCabRaw) || 21;   // 合约在 0 时回退 INIT_NUM_OF_CABINETS = 21
    const all = elected.map((a) => a.toLowerCase());
    return { elected: all, cabinet: all.slice(0, numCab) };
  }

  // Returns slash counts for all living validators
  async getSlashStatus() {
    const [validators] = await this.validatorSet.getLivingValidators();
    const [misdemeanor, felony] = await Promise.all([
      this.slash.misdemeanorThreshold(),
      this.slash.felonyThreshold(),
    ]);

    const results = await Promise.all(
      validators.map(async (addr) => {
        const [slashHeight, slashCount] = await this.slash.getSlashIndicator(addr);
        return {
          consensusAddr: addr,
          slashHeight:   Number(slashHeight),
          slashCount:    Number(slashCount),
          misdemeanor:   Number(misdemeanor),
          felony:        Number(felony),
          // warn if approaching misdemeanor threshold (>50%)
          status:
            Number(slashCount) >= Number(felony)      ? "felony"
            : Number(slashCount) >= Number(misdemeanor) ? "misdemeanor"
            : Number(slashCount) > Number(misdemeanor) / 2 ? "warn"
            : "ok",
        };
      })
    );

    return results.sort((a, b) => b.slashCount - a.slashCount);
  }

  // Returns validator election info with voting power
  async getValidatorSet() {
    const info = await this.stakeHub.getValidatorElectionInfo(0, 0);
    const consensusAddrs = info[0];
    const votingPowers   = info[1];
    const total          = Number(info[3]);

    return Array.from({ length: total }, (_, i) => ({
      consensusAddr: consensusAddrs[i],
      votingPower:   Number(votingPowers[i] / 10n ** 18n),
    }));
  }
}
