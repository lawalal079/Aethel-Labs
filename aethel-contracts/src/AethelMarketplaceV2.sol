// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

interface IERC20 {
    function transferFrom(
        address sender,
        address recipient,
        uint256 amount
    ) external returns (bool);

    function transfer(
        address recipient,
        uint256 amount
    ) external returns (bool);
}

/**
 * @title Æthel Labs: Open Upgradeable Agent Marketplace (V2)
 * @notice UUPS-compliant marketplace allowing multi-vendor listings, custom splits,
 *         listing bonds (anti-spam), manual approval gating, and platform suspension authority.
 *
 * CHANGES FROM V1 (see AETHEL_LABS_ROADMAP.md Decisions Log, 2026-07-22):
 * - Listings now require a USDC stake/bond, refundable on voluntary delist, slashable for cause.
 * - Listings are NOT live for purchase until manually approved by the owner (hackathon MVP —
 *   full permissionless listing with stake/slash-only enforcement is a post-hackathon item).
 * - Added `recurringFeeBps` per listing — the platform's cut of ongoing task-fee revenue.
 *   This rate is OWNER-CONTROLLED, not developer-set: new listings inherit the owner's
 *   `defaultRecurringFeeBps` at listing time, and the owner can override any specific
 *   listing's rate later via `setRecurringFee`. NOTE: this contract only enforces the cut
 *   on the one-time license purchase; enforcing the recurring cut on per-task Nanopayments
 *   revenue happens in the backend/Gateway routing layer, NOT on-chain here (Nanopayments
 *   settlement doesn't route through this contract). This field exists so the rate is
 *   transparent and queryable on-chain, even though enforcement lives elsewhere. See
 *   roadmap Section 5 before changing this design.
 * - Added `suspendAgent` (owner-only, for-cause) as distinct from `delistAgent` (creator-initiated,
 *   voluntary, stake-returning). Suspension reasons are emitted on-chain for transparency.
 *
 * DEPLOY NOTE: This is a FRESH deployment, NOT an in-place upgrade from V1.
 * The AgentListing struct layout is incompatible with V1 (field reordering, bool→enum).
 * V1 proxy (0x86552B0e39CF2b4861cd0d34254F0fd98d23E852) is abandoned.
 */
contract AethelMarketplaceV2 is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable
{
    address public protocolTreasury;
    address public usdcToken;
    uint256 public platformFeeBps; // e.g., 500 = 5% platform fee cut on license purchase
    uint256 public minListingStake; // USDC required (6 decimals) to list an agent
    uint256 public defaultRecurringFeeBps; // Owner-controlled default cut of ongoing task-fee revenue (bps)

    enum ListingStatus {
        PendingApproval,
        Approved,
        Delisted, // voluntary, creator-initiated — stake returned
        Suspended // for-cause, owner-initiated — stake may be slashed
    }

    struct AgentListing {
        string agentId;
        address creator;
        address engineWallet; // dev's own wallet that receives ongoing Nanopayments task fees
        uint256 price; // Configured in 6 decimals for stable USDC tracking
        uint256 stakedAmount; // USDC currently held as this listing's bond
        uint256 recurringFeeBps; // reference rate for platform's cut of ongoing task fees (enforced off-chain)
        ListingStatus status;
        string metadataUri;
    }

    // Market item directory: agentId => Listing details
    mapping(string => AgentListing) public marketRegistry;

    // Access ledger to verify ownership: userAddress => agentId => activeLicense
    mapping(address => mapping(string => bool)) public userLicenses;

    event AgentListed(
        string indexed agentId,
        uint256 price,
        uint256 stakedAmount,
        string metadataUri,
        address indexed developer,
        address engineWallet
    );
    event AgentApproved(string indexed agentId);
    event AgentDelisted(string indexed agentId, uint256 stakeReturned);
    event AgentSuspended(string indexed agentId, string reason, uint256 stakeSlashed);
    event AgentPurchased(
        address indexed buyer,
        string indexed agentId,
        uint256 totalPaid
    );
    /**
     * @notice Emitted when the owner grants a license directly (migration / admin override).
     * @dev This bypasses payment — restricted to onlyOwner for migration only.
     */
    event LicenseGranted(address indexed user, string indexed agentId);
    event FeeConfigUpdated(uint256 newFee);
    event RecurringFeeConfigUpdated(string indexed agentId, uint256 newRecurringFeeBps);
    event MinStakeUpdated(uint256 newMinStake);
    event TreasuryUpdated(
        address indexed oldTreasury,
        address indexed newTreasury
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // Essential Security Rule: Prevents direct interaction with the logic impl
        _disableInitializers();
    }

    /**
     * @notice Replaces the standard constructor for deployment proxy frameworks
     */
    function initialize(
        address _usdcToken,
        address _protocolTreasury
    ) public initializer {
        __Ownable_init(msg.sender);
        // Note: __UUPSUpgradeable_init() was removed in OZ v5 (was always a no-op).
        // __Ownable_init is the only required init call for this contract.

        usdcToken = _usdcToken;
        protocolTreasury = _protocolTreasury;
        platformFeeBps = 1000; // 10% cut for the platform on license purchases (testnet placeholder — revisit before mainnet)
        defaultRecurringFeeBps = 1000; // 10% default reference cut of ongoing task-fee revenue — owner-controlled, not dev-set
        minListingStake = 20_000000; // Default: 20 USDC bond to list (6 decimals) — tune before mainnet
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyOwner {}

    /**
     * @notice Allows any developer to submit an agent listing for review. Requires a USDC stake.
     *         Listing is NOT purchasable until approved by the owner (see approveAgent).
     *         The platform's recurring task-fee cut (recurringFeeBps) is set from the owner-
     *         controlled `defaultRecurringFeeBps` at listing time — developers cannot set their
     *         own rate. The owner can override it per-listing later via setRecurringFee.
     * @param _agentId The unique string identifier for the system mapping
     * @param _price The one-time license price, in 6-decimals (e.g., 10000000 for $10.00)
     * @param _metadataUri Metadata URI containing JSON strings for UI rendering
     * @param _engineWallet The developer's own wallet address that will receive ongoing task-fee revenue
     */
    function listAgent(
        string calldata _agentId,
        uint256 _price,
        string calldata _metadataUri,
        address _engineWallet
    ) external {
        require(_price > 0, "Aethel: Price must exceed zero");
        require(_engineWallet != address(0), "Aethel: Engine wallet required");
        require(
            marketRegistry[_agentId].creator == address(0),
            "Aethel: Agent ID already registered"
        );

        // Pull the listing stake/bond into the contract as anti-spam collateral
        require(
            IERC20(usdcToken).transferFrom(msg.sender, address(this), minListingStake),
            "Aethel: Stake transfer failed"
        );

        marketRegistry[_agentId] = AgentListing({
            agentId: _agentId,
            creator: msg.sender,
            engineWallet: _engineWallet,
            price: _price,
            stakedAmount: minListingStake,
            recurringFeeBps: defaultRecurringFeeBps,
            status: ListingStatus.PendingApproval,
            metadataUri: _metadataUri
        });

        emit AgentListed(_agentId, _price, minListingStake, _metadataUri, msg.sender, _engineWallet);
    }

    /**
     * @notice Owner-only: approve a pending listing, making it purchasable.
     *         This is the manual review gate for the hackathon MVP anti-spam plan.
     */
    function approveAgent(string calldata _agentId) external onlyOwner {
        AgentListing storage item = marketRegistry[_agentId];
        require(item.creator != address(0), "Aethel: Agent not registered");
        require(item.status == ListingStatus.PendingApproval, "Aethel: Not pending approval");

        item.status = ListingStatus.Approved;
        emit AgentApproved(_agentId);
    }

    /**
     * @notice Allows a user to buy an agent license. Requires the listing to be Approved.
     *         Dynamically routes splits to creator and protocol treasury.
     * @param _agentId The specific tool or software stack identifier being deployed
     */
    function purchaseAgent(string calldata _agentId) external {
        AgentListing memory item = marketRegistry[_agentId];

        require(item.status == ListingStatus.Approved, "Aethel: Agent is not approved for purchase");
        require(
            !userLicenses[msg.sender][_agentId],
            "Aethel: License already claimed"
        );

        // Calculate fee breakdowns utilizing Basis Points (BPS)
        uint256 platformCut = (item.price * platformFeeBps) / 10000;
        uint256 creatorCut = item.price - platformCut;

        require(
            IERC20(usdcToken).transferFrom(
                msg.sender,
                address(this),
                item.price
            ),
            "Aethel: USDC transfer failed"
        );

        if (platformCut > 0) {
            IERC20(usdcToken).transfer(protocolTreasury, platformCut);
        }
        IERC20(usdcToken).transfer(item.creator, creatorCut);

        userLicenses[msg.sender][_agentId] = true;

        emit AgentPurchased(msg.sender, _agentId, item.price);
    }

    /**
     * @notice Allows creators to voluntarily remove their own listing. Returns the full stake.
     */
    function delistAgent(string calldata _agentId) external {
        AgentListing storage item = marketRegistry[_agentId];
        require(item.creator == msg.sender, "Aethel: Not your listing");
        require(
            item.status == ListingStatus.PendingApproval || item.status == ListingStatus.Approved,
            "Aethel: Already delisted or suspended"
        );

        uint256 refund = item.stakedAmount;
        item.status = ListingStatus.Delisted;
        item.stakedAmount = 0;

        if (refund > 0) {
            IERC20(usdcToken).transfer(item.creator, refund);
        }

        emit AgentDelisted(_agentId, refund);
    }

    /**
     * @notice Owner-only: suspend a listing for cause (fraud, repeated failures, harm to users).
     *         Unlike voluntary delisting, the stake may be partially or fully slashed to the
     *         treasury depending on severity — full transparency via the emitted reason.
     * @param _agentId The listing to suspend
     * @param _reason Human-readable cause, emitted on-chain for transparency
     * @param _slashAmount Amount of the stake to slash to treasury (must be <= staked amount)
     */
    function suspendAgent(
        string calldata _agentId,
        string calldata _reason,
        uint256 _slashAmount
    ) external onlyOwner {
        AgentListing storage item = marketRegistry[_agentId];
        require(item.creator != address(0), "Aethel: Agent not registered");
        require(
            item.status == ListingStatus.PendingApproval || item.status == ListingStatus.Approved,
            "Aethel: Already delisted or suspended"
        );
        require(_slashAmount <= item.stakedAmount, "Aethel: Slash exceeds stake");

        uint256 remainingStake = item.stakedAmount - _slashAmount;
        item.status = ListingStatus.Suspended;
        item.stakedAmount = 0;

        if (_slashAmount > 0) {
            IERC20(usdcToken).transfer(protocolTreasury, _slashAmount);
        }
        if (remainingStake > 0) {
            IERC20(usdcToken).transfer(item.creator, remainingStake);
        }

        emit AgentSuspended(_agentId, _reason, _slashAmount);
    }

    /**
     * @notice Owner-only: grant a license directly to any address, bypassing payment.
     *         Intended exclusively for wallet-migration scenarios (e.g. moving licenses from
     *         a User-Controlled wallet to a Developer-Controlled Fee Wallet address).
     *         NOT a general-purpose freebie mechanism — do not expose to users.
     * @param _user   The address that should receive the license
     * @param _agentId The agent the license is granted for
     */
    function grantLicense(address _user, string calldata _agentId) external onlyOwner {
        require(_user != address(0), "Aethel: Zero address");
        require(bytes(_agentId).length > 0, "Aethel: Empty agentId");
        require(!userLicenses[_user][_agentId], "Aethel: License already active");
        userLicenses[_user][_agentId] = true;
        emit LicenseGranted(_user, _agentId);
    }


    function setPlatformFee(uint256 _newFeeBps) external onlyOwner {
        require(_newFeeBps <= 2000, "Aethel: Cap is 20%");
        platformFeeBps = _newFeeBps;
        emit FeeConfigUpdated(_newFeeBps);
    }

    /**
     * @notice Owner-only: update the platform's default recurring task-fee cut applied to
     *         new listings going forward. Does not retroactively change existing listings —
     *         use setRecurringFee for that.
     */
    function setDefaultRecurringFee(uint256 _newDefaultBps) external onlyOwner {
        require(_newDefaultBps <= 2000, "Aethel: Recurring fee cap is 20%");
        defaultRecurringFeeBps = _newDefaultBps;
    }

    /**
     * @notice Owner-only: update the reference recurring-fee rate for a specific listing.
     *         This is metadata for off-chain enforcement, not an on-chain transfer.
     */
    function setRecurringFee(string calldata _agentId, uint256 _newRecurringFeeBps) external onlyOwner {
        require(_newRecurringFeeBps <= 2000, "Aethel: Recurring fee cap is 20%");
        AgentListing storage item = marketRegistry[_agentId];
        require(item.creator != address(0), "Aethel: Agent not registered");
        item.recurringFeeBps = _newRecurringFeeBps;
        emit RecurringFeeConfigUpdated(_agentId, _newRecurringFeeBps);
    }

    function setMinListingStake(uint256 _newMinStake) external onlyOwner {
        minListingStake = _newMinStake;
        emit MinStakeUpdated(_newMinStake);
    }

    function updateTreasury(address _newTreasury) external onlyOwner {
        require(_newTreasury != address(0), "Aethel: Invalid treasury address");
        address oldTreasury = protocolTreasury;
        protocolTreasury = _newTreasury;

        emit TreasuryUpdated(oldTreasury, _newTreasury);
    }

    /**
     * @notice Allows the original listing creator or the protocol owner to update
     *         the metadataUri for an existing agent registration.
     */
    function setAgentMetadata(string calldata _agentId, string calldata _metadataUri) external {
        address creator = marketRegistry[_agentId].creator;
        require(creator != address(0), "Aethel: Agent not registered");
        require(
            msg.sender == creator || msg.sender == owner(),
            "Aethel: Not authorized"
        );
        marketRegistry[_agentId].metadataUri = _metadataUri;
    }
}
