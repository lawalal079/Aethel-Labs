// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/AethelMarketplaceV2.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract MockUSDC {
    string public name = "Mock USDC";
    string public symbol = "USDC";
    uint8 public decimals = 6;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor() {
        _mint(msg.sender, 1_000_000 * 10**6);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "ERC20: transfer amount exceeds balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
        emit Transfer(msg.sender, recipient, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool) {
        require(balanceOf[sender] >= amount, "ERC20: transfer amount exceeds balance");
        require(allowance[sender][msg.sender] >= amount, "ERC20: transfer amount exceeds allowance");
        allowance[sender][msg.sender] -= amount;
        balanceOf[sender] -= amount;
        balanceOf[recipient] += amount;
        emit Transfer(sender, recipient, amount);
        return true;
    }

    function _mint(address account, uint256 amount) internal {
        totalSupply += amount;
        balanceOf[account] += amount;
        emit Transfer(address(0), account, amount);
    }
}

contract AethelMarketplaceV2Test is Test {
    AethelMarketplaceV2 public implementation;
    ERC1967Proxy public proxy;
    AethelMarketplaceV2 public marketplace;
    MockUSDC public usdc;

    address public owner;
    address public protocolTreasury;
    address public engineWallet;
    address public creator1;
    address public creator2;
    address public buyer1;
    address public buyer2;

    event AgentListed(
        string indexed agentId,
        uint256 price,
        uint256 stakedAmount,
        string metadataUri,
        address indexed developer,
        address engineWallet
    );
    event AgentApproved(string indexed agentId);
    event AgentPurchased(
        address indexed buyer,
        string indexed agentId,
        uint256 totalPaid
    );

    function setUp() public {
        owner = address(this);
        protocolTreasury = makeAddr("protocolTreasury");
        engineWallet = makeAddr("engineWallet");
        creator1 = makeAddr("creator1");
        creator2 = makeAddr("creator2");
        buyer1 = makeAddr("buyer1");
        buyer2 = makeAddr("buyer2");

        // Deploy Mock USDC (6 Decimals)
        usdc = new MockUSDC();

        // Mint USDC to creators & buyers for staking & purchases
        usdc.mint(creator1, 10_000 * 10**6);
        usdc.mint(creator2, 10_000 * 10**6);
        usdc.mint(buyer1, 10_000 * 10**6);
        usdc.mint(buyer2, 10_000 * 10**6);

        // Deploy Marketplace V2 Implementation
        implementation = new AethelMarketplaceV2();

        // Encode initialization data
        bytes memory data = abi.encodeWithSelector(
            AethelMarketplaceV2.initialize.selector,
            address(usdc),
            protocolTreasury
        );

        // Deploy ERC1967Proxy pointing to Implementation
        proxy = new ERC1967Proxy(address(implementation), data);

        // Wrap Proxy in V2 Interface
        marketplace = AethelMarketplaceV2(address(proxy));
    }

    function testInitialization() public view {
        assertEq(marketplace.usdcToken(), address(usdc));
        assertEq(marketplace.protocolTreasury(), protocolTreasury);
        assertEq(marketplace.platformFeeBps(), 1000);
        assertEq(marketplace.owner(), owner);
    }

    function testListAndApproveAgent() public {
        uint256 stake = 20 * 10**6; // 20 USDC bond
        uint256 price = 15 * 10**6; // 15 USDC price

        vm.startPrank(creator1);
        usdc.approve(address(marketplace), stake);

        vm.expectEmit(true, true, false, true);
        emit AgentListed("agent_1", price, stake, "meta1", creator1, engineWallet);
        marketplace.listAgent("agent_1", price, "meta1", engineWallet);
        vm.stopPrank();

        // Check registry before approval (status = PendingApproval = 0)
        (string memory id1, address c1, address eng1, uint256 p1, uint256 s1,, AethelMarketplaceV2.ListingStatus st1,) = marketplace.marketRegistry("agent_1");
        assertEq(id1, "agent_1");
        assertEq(c1, creator1);
        assertEq(eng1, engineWallet);
        assertEq(p1, price);
        assertEq(s1, stake);
        assertEq(uint8(st1), 0); // PendingApproval

        // Owner approves agent listing
        vm.expectEmit(true, false, false, false);
        emit AgentApproved("agent_1");
        marketplace.approveAgent("agent_1");

        // Check registry after approval (status = Approved = 1)
        (,,,,,, AethelMarketplaceV2.ListingStatus st1Approved,) = marketplace.marketRegistry("agent_1");
        assertEq(uint8(st1Approved), 1); // Approved
    }

    function testPurchaseApprovedAgent() public {
        uint256 stake = 20 * 10**6;
        uint256 price = 100 * 10**6; // $100 USDC

        // Creator lists agent
        vm.startPrank(creator1);
        usdc.approve(address(marketplace), stake);
        marketplace.listAgent("agent_smc", price, "meta_smc", engineWallet);
        vm.stopPrank();

        // Owner approves agent
        marketplace.approveAgent("agent_smc");

        // Buyer purchases license
        vm.startPrank(buyer1);
        usdc.approve(address(marketplace), price);

        vm.expectEmit(true, true, false, true);
        emit AgentPurchased(buyer1, "agent_smc", price);
        marketplace.purchaseAgent("agent_smc");
        vm.stopPrank();

        // Verify splits: 10% platform cut ($10 USDC), 90% creator cut ($90 USDC)
        uint256 expectedPlatformCut = (price * 1000) / 10000; // 10 USDC
        uint256 expectedCreatorCut = price - expectedPlatformCut; // 90 USDC

        assertEq(usdc.balanceOf(protocolTreasury), expectedPlatformCut);
        assertEq(usdc.balanceOf(creator1), 10_000 * 10**6 - stake + expectedCreatorCut);
        assertEq(usdc.balanceOf(buyer1), 10_000 * 10**6 - price);

        // Verify license recorded
        assertTrue(marketplace.userLicenses(buyer1, "agent_smc"));
    }

    function testCannotPurchasePendingAgent() public {
        uint256 stake = 20 * 10**6;
        uint256 price = 50 * 10**6;

        vm.startPrank(creator1);
        usdc.approve(address(marketplace), stake);
        marketplace.listAgent("agent_pending", price, "meta_p", engineWallet);
        vm.stopPrank();

        // Buyer tries to purchase without admin approval -> reverts
        vm.startPrank(buyer1);
        usdc.approve(address(marketplace), price);
        vm.expectRevert("Aethel: Agent is not approved for purchase");
        marketplace.purchaseAgent("agent_pending");
        vm.stopPrank();
    }
}
