'use strict';

import constants from './constants';
import storage from './storage';
import utils from './utils';
import Groups from './groups';
import Windows from './windows';

const newTabKeys = ['active', 'cookieStoreId', /*'index', */'discarded', 'title', 'openInReaderMode', 'pinned', 'url', 'windowId'];

async function create(tab) {
    const {BG} = browser.extension.getBackgroundPage();

    BG.console.log('create tab', tab);

    let {groupId, thumbnail, favIconUrl} = tab;

    if (!tab.url || !utils.isUrlAllowToCreate(tab.url)) {
        delete tab.url;
    }

    if (!tab.active) {
        tab.active = false;
    }

    if (!tab.pinned) {
        delete tab.pinned;
    }

    delete tab.discarded;

    if (!tab.active && !tab.pinned && tab.url && !utils.isUrlEmpty(tab.url)) {
        tab.discarded = true;
    }

    if (tab.active || !tab.discarded) {
        delete tab.title;
    }

    // if (!Number.isFinite(tab.index) || 0 > tab.index) { // index not need ?
    //     delete tab.index;
    // }

    if (!Number.isFinite(tab.windowId) || 1 > tab.windowId || !BG.cache.hasWindow(tab.windowId)) {
        delete tab.windowId;
    }

    if ('cookieStoreId' in tab) {
        tab.cookieStoreId = BG.containers.get(tab.cookieStoreId, 'cookieStoreId');
    }

    if (tab.isInReaderMode) {
        tab.openInReaderMode = true;
    }

    Object.keys(tab).forEach(key => !newTabKeys.includes(key) && (delete tab[key]));

    let newTab = await BG.browser.tabs.create(tab);

    BG.console.log('tab created', {tab, newTab});

    if (groupId && !newTab.pinned) {
        BG.cache.setTabGroup(newTab.id, groupId);
    }

    if (thumbnail) {
        BG.cache.setTabThumbnail(newTab.id, thumbnail);
    }

    if (favIconUrl) {
        BG.cache.setTabFavIcon(newTab.id, favIconUrl);
    }

    newTab.session = BG.cache.getTabSession(newTab.id);

    if (newTab.session.groupId) {
        BG.sendMessage({
            action: 'tab-added',
            tab: newTab,
        });
    }

    return newTab;
}

async function setActive(tabId, tabs = []) {
    let tabToActive = null;

    if (tabId) {
        tabToActive = tabs.find(tab => tab.id === tabId) || {
            id: tabId,
        };
    } else if (tabs.length) { // find lastAccessed tab
        let maxLastAccessed = Math.max(...tabs.map(tab => tab.lastAccessed));

        tabToActive = tabs.find(tab => tab.lastAccessed === maxLastAccessed);
    }

    if (tabToActive) {
        tabs.forEach(tab => tab.active = tab.id === tabToActive.id);

        const {BG} = browser.extension.getBackgroundPage();

        await BG.browser.tabs.update(tabToActive.id, {
            active: true,
        });
    }

    return tabToActive;
}

async function getActive(windowId = browser.windows.WINDOW_ID_CURRENT) {
    let [activeTab] = await get(windowId, null, null, {
        active: true,
    });

    return activeTab;
}

async function getHighlighted(windowId = browser.windows.WINDOW_ID_CURRENT, clickedTab = null) {
    const {BG} = browser.extension.getBackgroundPage();

    let tabs = await get(windowId, false, false, {
        highlighted: true,
    });

    if (clickedTab && !tabs.some(tab => tab.id === clickedTab.id)) { // if clicked tab not in selected tabs - add it
        tabs.push(clickedTab);

        if (2 === tabs.length) {
            tabs = tabs.filter(tab => tab.active ? (tab.id === clickedTab.id) : true); // exclude active tab if need to move another tab
        }
    }

    return tabs;
}

async function get(windowId = browser.windows.WINDOW_ID_CURRENT, pinned = false, hidden = false, otherProps = {}) {
    const {BG} = browser.extension.getBackgroundPage();

    let query = {
        windowId,
        pinned,
        hidden,
        windowType: browser.windows.WindowType.NORMAL,
        ...otherProps,
    };

    if (null === windowId) {
        delete query.windowId;
    }

    if (null === pinned) {
        delete query.pinned;
    }

    if (null === hidden) {
        delete query.hidden;
    }

    let tabs = await BG.browser.tabs.query(query);

    tabs = tabs.filter(BG.cache.filterRemovedTab);

    return query.pinned ? tabs : Promise.all(tabs.map(BG.cache.loadTabSession));
}

async function setMute(tabs, muted) {
    const {BG} = browser.extension.getBackgroundPage();

    return Promise.all(
        tabs
        .filter(tab => muted ? tab.audible : tab.mutedInfo.muted)
        .map(tab => BG.browser.tabs.update(tab.id, {muted}))
    );
}

async function createTempActiveTab(windowId, createPinnedTab = true, newTabUrl) {
    const {BG} = browser.extension.getBackgroundPage();

    let pinnedTabs = await get(windowId, true, null);

    if (pinnedTabs.length) {
        if (!pinnedTabs.some(tab => tab.active)) {
            await setActive(pinnedTabs.sort(utils.sortBy('lastAccessed')).pop().id);
        }
    } else {
        newTabUrl = createPinnedTab ? (newTabUrl || 'about:blank') : (newTabUrl || 'about:newtab');

        return create({
            url: newTabUrl,
            pinned: createPinnedTab,
            active: true,
            windowId: windowId,
        });
    }
}

async function add(groupId, cookieStoreId, url, title, active = false) {
    const {BG} = browser.extension.getBackgroundPage();

    let windowId = BG.cache.getWindowId(groupId),
        [tab] = await BG.createTabsSafe([{
            url,
            title,
            active,
            cookieStoreId,
            groupId,
            windowId,
        }], !windowId);

    return tab;
}

async function remove({id, hidden, session}) {
    const {BG} = browser.extension.getBackgroundPage();

    // if (!hidden) { // TODO что делать?
    //     let groupWindowId = BG.cache.getWindowId(session.groupId);

    //     if (groupWindowId) {
    //         let [group] = await Groups.load(session.groupId, true);

    //         if (1 === group.tabs.length) {
    //             let pinnedTabs = await get(groupWindowId, true, null);

    //             if (!pinnedTabs.length) {
    //                 await create({
    //                     active: true,
    //                     windowId: groupWindowId,
    //                 });
    //             }
    //         }
    //     }
    // }

    await BG.browser.tabs.remove(id);
}

async function updateThumbnail(tabId, force) {
    const {BG} = browser.extension.getBackgroundPage();

    let hasThumbnailsPermission = await BG.browser.permissions.contains(constants.PERMISSIONS.ALL_URLS);

    if (!hasThumbnailsPermission) {
        return;
    }

    let tab = await BG.browser.tabs.get(tabId);

    if (!utils.isTabLoaded(tab)) {
        return;
    }

    if (!force && BG.cache.getTabSession(tab.id, 'thumbnail')) {
        return;
    }

    if (tab.discarded) {
        reload([tab.id]);
        return;
    }

    let thumbnail = null;

    try {
        let thumbnailBase64 = await BG.browser.tabs.captureTab(tab.id, {
            format: browser.extensionTypes.ImageFormat.JPEG,
            quality: 25,
        });

        thumbnail = await new Promise(function(resolve, reject) {
            let img = new Image();

            img.onload = function() {
                resolve(utils.resizeImage(img, 192, Math.floor(img.width * 192 / img.height), false, 'image/jpeg', 0.7));
            };

            img.onerror = img.onabort = reject;

            img.src = thumbnailBase64;
        });
    } catch (e) {}

    BG.cache.setTabThumbnail(tab.id, thumbnail);

    BG.sendMessage({
        action: 'thumbnail-updated',
        tabId: tab.id,
        thumbnail: thumbnail,
    });
}

async function move(tabs, groupId, newTabIndex = -1, showNotificationAfterMoveTab = true, showTabAfterMoving = false) {
    // tabs = utils.clone(tabs);
    const {BG} = browser.extension.getBackgroundPage();

    BG.console.info('moveTabs', {groupId, newTabIndex, showNotificationAfterMoveTab, showTabAfterMoving, tabs});
    // console.info('moveTabs tabs 0', tabs[0]);

    BG.addExcludeTabsIds(tabs.map(utils.keyId));

    let showPinnedMessage = false,
        tabsCantHide = [],
        groupWindowId = BG.cache.getWindowId(groupId),
        windowId = groupWindowId,
        [group, groups] = await Groups.load(groupId, true),
        activeTabs = [];

    if (!windowId) {
        windowId = group.tabs.length ? group.tabs[0].windowId : await Windows.getLastFocusedNormalWindow();
    }

    tabs = tabs.filter(function(tab) {
        if (tab.pinned) {
            showPinnedMessage = true;
            return false;
        }

        if (utils.isTabCanNotBeHidden(tab)) {
            let tabTitle = utils.getTabTitle(tab, false, 20);

            if (!tabsCantHide.includes(tabTitle)) {
                tabsCantHide.push(tabTitle);
            }

            return false;
        }

        if (tab.active) {
            activeTabs.push(tab);
        }

        return true;
    });

    if (tabs.length) {
        let windows = activeTabs.length ? await Windows.load(true) : [];

        await Promise.all(activeTabs.map(async function(activeTab) {
            let winGroupId = BG.cache.getWindowGroup(activeTab.windowId),
                tabsToActive = [];

            if (winGroupId) {
                tabsToActive = groups.find(gr => gr.id === winGroupId).tabs.filter(t => t.id !== activeTab.id);
            } else {
                tabsToActive = windows.find(win => win.id === activeTab.windowId).tabs.filter(t => !t.hidden && t.id !== activeTab.id);
            }

            if (tabsToActive.length) {
                await setActive(undefined, tabsToActive);
            } else if (!winGroupId || activeTab.windowId !== windowId) {
                await createTempActiveTab(activeTab.windowId, false);
            }
        }));

        let tabIds = tabs.map(utils.keyId);

        tabs = await moveNative(tabs, {
            index: newTabIndex,
            windowId,
        });

        if (groupWindowId) {
            let tabsToShow = tabs.filter(tab => tab.hidden);

            if (tabsToShow.length) {
                await BG.browser.tabs.show(tabsToShow.map(utils.keyId));
            }
        } else {
            let tabsToHide = tabs.filter(tab => !tab.hidden);

            if (tabsToHide.length) {
                await BG.browser.tabs.hide(tabsToHide.map(utils.keyId));
            }
        }

        BG.removeExcludeTabsIds(tabIds);

        await Promise.all(tabIds.map(tabId => BG.cache.setTabGroup(tabId, groupId)));

        BG.sendMessage({
            action: 'groups-updated',
        });
    } else {
        BG.removeExcludeTabsIds(tabs.map(utils.keyId));
    }

    if (showPinnedMessage) {
        utils.notify(browser.i18n.getMessage('pinnedTabsAreNotSupported'));
    }

    if (tabsCantHide.length) {
        utils.notify(browser.i18n.getMessage('thisTabsCanNotBeHidden', tabsCantHide.join(', ')));
    }

    if (!tabs.length) {
        return [];
    }

    if (showTabAfterMoving) {
        await BG.applyGroup(windowId, groupId, tabs[0].id);
        showNotificationAfterMoveTab = false;
    }

    if (!showNotificationAfterMoveTab || !BG.getOptions().showNotificationAfterMoveTab) {
        return tabs;
    }

    let message = '';

    if (tabs.length > 1) {
        message = browser.i18n.getMessage('moveMultipleTabsToGroupMessage', tabs.length);
    } else {
        let tabTitle = utils.getTabTitle(tabs[0], false, 50);
        message = browser.i18n.getMessage('moveTabToGroupMessage', [group.title, tabTitle]);
    }

    utils.notify(message)
        .then(async function(groupId, tabId) {
            let [group] = await Groups.load(groupId),
                tab = await BG.browser.tabs.get(tabId).catch(function() {});

            if (group && tab) {
                let winId = BG.cache.getWindowId(groupId) || await Windows.getLastFocusedNormalWindow();

                BG.applyGroup(winId, groupId, tabId);
            }
        }.bind(null, groupId, tabs[0].id));

    return tabs;
}

// temp fix bug https://bugzilla.mozilla.org/show_bug.cgi?id=1580879
async function moveNative(tabs, options = {}) {
    const {BG} = browser.extension.getBackgroundPage();

    console.log('tabs before moving', tabs);

    let result = await BG.browser.tabs.move(tabs.map(utils.keyId), options);

    result.forEach(function(tab, index) {
        if (tab.discarded && utils.isUrlEmpty(tab.url) && tab.url !== tabs[index].url) {
            tab.url = tabs[index].url;
            reload(tab.id, true);
        }
    });

    return result;
}

async function discard(tabIds = []) {
    if (tabIds.length) {
        const {BG} = browser.extension.getBackgroundPage();
        return BG.browser.tabs.discard(tabIds).catch(function() {});
    }
}

const extensionsWebextensionsRestrictedDomains = ['accounts-static.cdn.mozilla.net','accounts.firefox.com','addons.cdn.mozilla.net','addons.mozilla.org','api.accounts.firefox.com','content.cdn.mozilla.net','discovery.addons.mozilla.org','install.mozilla.org','oauth.accounts.firefox.com','profile.accounts.firefox.com','support.mozilla.org','sync.services.mozilla.com'];

function isCanSendMessage(tabUrl) {
    if (tabUrl === 'about:blank') {
        return true;
    }

    if (tabUrl.startsWith('moz-extension')) {
        return false;
    }

    return /.*:\/\/.+/.test(tabUrl) && !extensionsWebextensionsRestrictedDomains.some(host => (new RegExp('^https?://' + host).test(tabUrl)));
}

function sendMessage(tabId, message) {
    const {BG} = browser.extension.getBackgroundPage();

    return BG.browser.tabs.sendMessage(tabId, message).catch(function() {});
}

async function reload(tabIds = [], bypassCache = false) {
    const {BG} = browser.extension.getBackgroundPage();
    await Promise.all(tabIds.map(tabId => BG.browser.tabs.reload(tabId, {bypassCache}).catch(function() {})));
}

export default {
    create,
    setActive,
    getActive,
    getHighlighted,
    get,
    setMute,
    createTempActiveTab,
    add,
    remove,
    updateThumbnail,
    move,
    moveNative,
    discard,
    isCanSendMessage,
    sendMessage,
    reload,
};