/* global isEmpty, padNumber, cloneObject, isObject, getFormattedDate, snipLimits */
/* global $, setTextForNode, getHTML, SNIP_NAME_LIMIT, SNIP_BODY_LIMIT */
/* global triggerEvent, setHTML, MONTHS, formatTextForNodeDisplay, chrome */
/* global escapeRegExp, getText*/

var contextMenuActionBlockSite,	
	wasOnBlockedSite = false,
	BLOCK_SITE_ID = "blockSite", SNIPPET_MAIN_ID = "snippet_main",
	// boolean set to true on updating app
	// so that user gets updated snippet list whenever he comes
	// on valid website (not chrome://extension)
	needToGetLatestData = false,
	// can recall at max 10 times
	// for gettting the blocked site status in case of unfinished loading of cs.js
	LIMIT_OF_RECALLS = 10,
	recalls = 0,
	// received from cs.js; when there are mutliple iframes on a page
	// this helps remove the ambiguity as to which one was latest
	// storing it in background.js so as to provide a global one-stop center
	// content scripts, which cannot interact among themselves
	latestCtxTimestamp;

// so that snippet_classes.js can work properly
window.Data = {};
Data.snippets = new Folder("Snippets");
window.listOfSnippetCtxIDs = [];
	
Folder.setIndices();

function getDomain(url){
	url = url.replace(/^(ht|f)tps?(:\/\/)?(www\.)?/, "").split("/");
	var domain = url[0], path1 = url[1], idx;
	
	if(path1){
		// remove all the unnecessary query/anchors parameter content
		idx = path1.indexOf("?");
		if(idx !== -1) path1 = path1.substring(0, idx);
		
		domain += "/" + path1;
	}
	
	return domain;
}

function getPasteData(){
	var $elm = document.createElement("textarea"),
		$actElm = document.activeElement.appendChild($elm).parentNode;
    
	$elm.focus();	
    document.execCommand("Paste", null, null);
    
	var data = $elm.value;	
    $actElm.removeChild($elm);
	
    return data;
}

function injectScript(tab){
	if (!tab || !tab.id) return;

	// loop through content scripts and execute in order
	var contentScripts = chrome.runtime.getManifest().content_scripts[0].js;

	for (var i = 0, len = contentScripts.length; i < len; i++)
		if(!/chrome(-extension)?:\/\//.test(tab.url))
			chrome.tabs.executeScript(tab.id, {
				file: contentScripts[i]
			});
}

function createBlockSiteCtxItem(){
	chrome.contextMenus.create({
		id: BLOCK_SITE_ID,
		title: "reload page for blocking site"
	});
}

function openSnippetsPage(version, reason){
	chrome.tabs.create({
		url: chrome.extension.getURL("html/options.html#snippets")
	});
	
	if(version === "3.0.0" && reason === "update")
		localStorage.prepare300Update = true;
}

// create modal dialog for blocking site by detector.js
(function createBlockSiteModal(){
	var modalContent = "<div class='block block-theme-plain'>\
		<div class='block-overlay'></div>\
		<div class='block-content'>\
			<div class='block-dialog-form'>\
				<div class='block-dialog-message'>Are you sure you want to <span class='action'></span><br> <input type='text' class='site-name'><br> from ProKeys?</div>\
				<div class='block-dialog-buttons'>\
					<input type='button' value='OK' class='block-dialog-button-primary block-dialog-button'>\
					<input type='button' value='Cancel' class='block-dialog-button-secondary block-dialog-button'> </div>\
			</div>\
		</div></div>";
	
	window.modalHTML = modalContent;
})();
	
chrome.runtime.onInstalled.addListener(function(details){
	var text, title, reason = details.reason,
		version = chrome.runtime.getManifest().version;
	
	if(reason === "install"){
		// TODO: greeting for user
		openSnippetsPage(version);
		
		title = "ProKeys successfully installed!";
		text = "Thank you for installing ProKeys! Please reload all active tabs for changes to take effect.";
		
		// inject script into all active tabs
		// so that user is not required to do manual reload
		chrome.tabs.query({}, function(tabs){
			tabs.forEach(injectScript);
		});
	}
	else if(reason === "update"){		
		title = "ProKeys successfully updated to v" + version;
		text = "Please reload active tabs to use the new version.";
		// TODO: explain changes to user
		openSnippetsPage(version, reason);
		needToGetLatestData = true;
	}

	// either update or install was there
	if(text !== void 0){
		// the empty function and string is required < Chrome 42
		chrome.notifications.create("", {
			type: "basic",
			iconUrl: "imgs/r128.png",
			title: title,
			message: text
		}, function(id){});
	}
});

try{
	updateContextMenu();
}catch(e){
	console.log("Error", e, e.getMessage());
}

try{
	createBlockSiteCtxItem();
}catch(e){
	chrome.contextMenus.remove(BLOCK_SITE_ID);
	createBlockSiteCtxItem();
}

try{
	addCtxSnippetList(Data.snippets, true);
}catch(e){
	chrome.contextMenus.remove(SNIPPET_MAIN_ID);	
	addCtxSnippetList(Data.snippets, true);
	
}

chrome.contextMenus.onClicked.addListener(function(info, tab){
	var id = info.menuItemId,
		url = info.pageUrl, msg;
	
	if(id === BLOCK_SITE_ID){
		msg = {
			task: "showModal",
			action: contextMenuActionBlockSite,
			url: getDomain(url),
			modal: modalHTML
		};
		
		chrome.tabs.query({active: true, currentWindow: true}, function(tabs){
			chrome.tabs.sendMessage(tabs[0].id, msg);
		});
	}
	else if(Generic.CTX_SNIP_REGEX.test(id)){
		snip = Data.snippets.getUniqueSnip(id.substring(Generic.CTX_START[Generic.SNIP_TYPE].length));
		//console.log(snip, id.substring(Generic.CTX_START[Generic.SNIP_TYPE].length));
		chrome.tabs.query({active: true, currentWindow: true}, function(tabs){			
			if(tabs[0])
				chrome.tabs.sendMessage(tabs[0].id, {
					clickedSnippet: snip.toArray(), ctxTimestamp: latestCtxTimestamp
				});
		});	
	}	
});

chrome.tabs.onActivated.addListener(function(info) { updateContextMenu(); });

chrome.tabs.onUpdated.addListener(function(tabId, info, tab) {
	chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {	
		if (tabs[0] && tabs[0].id === tabId)
			updateContextMenu();
	});
});

// isRecalled: if the function has been called
// if the response from content script was undefined
// why content script sends undefined response is i don't know
function updateContextMenu(isRecalled) {
	if(isRecalled) recalls++;
	else recalls = 0;
	
	chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {		
		var isBlocked;
		
		if(typeof tabs[0] === "undefined") return;
		
		chrome.tabs.sendMessage(tabs[0].id, {checkBlockedYourself: true}, function(response){
			isBlocked = response;
			
			contextMenuActionBlockSite = isBlocked === undefined ? "reload page for (un)blocking" :
										(isBlocked ? "Unblock" : "Block");
										
			if(isBlocked === undefined){
				if(recalls <= LIMIT_OF_RECALLS)
					setTimeout(updateContextMenu, 500, true);
				else 
					chrome.contextMenus.update(BLOCK_SITE_ID, {
						title: "Unable to block/unblock this site"
					});
				
				return;
			}
			
			// remove all snippet support as well
			if(isBlocked) {
				removeCtxSnippetList(true);
				console.log(listOfSnippetCtxIDs);
			}
			else if(wasOnBlockedSite){
				wasOnBlockedSite = false;
				addCtxSnippetList(Data.snippets, true);
			}			
			
			chrome.contextMenus.update(BLOCK_SITE_ID, {
				title: contextMenuActionBlockSite + " this site"
			});
		});
		
		if(needToGetLatestData){
			chrome.tabs.sendMessage(tabs[0].id, {giveSnippetList: true}, function(response){
				if(Array.isArray(response)){
					needToGetLatestData = false;
					addCtxSnippetList(Folder.fromArray(response), true);
				}
			});		
		}
	});
}

function addCtxSnippetList(snippets, addMainEntryFlag){
	function addMainEntry(){
		chrome.contextMenus.create({
			contexts: ["editable"],
			id: SNIPPET_MAIN_ID,
			title: hasSnippets ? "Click any snippet to insert it" : "No snippet to insert"
		}, function(){
			if(chrome.runtime.lastError){
				// already exists, so first remove it
				chrome.contextMenus.remove(SNIPPET_MAIN_ID);
				addMainEntry();
			}
		});
	}
	
	removeCtxSnippetList();	
	
	Data.snippets = snippets;
	Folder.setIndices();
	var hasSnippets = Data.snippets.list.length > 0;
	
	if(addMainEntryFlag) addMainEntry();
	
	// now create the new context menus
	snippets.createCtxMenuEntry();
}

function removeCtxSnippetList(removeMainEntryFlag){
	while(listOfSnippetCtxIDs.length > 0)
		chrome.contextMenus.remove(listOfSnippetCtxIDs.pop());	
	
	if(removeMainEntryFlag) {
		wasOnBlockedSite = true;
		chrome.contextMenus.remove(SNIPPET_MAIN_ID);
	}
}

chrome.extension.onMessage.addListener(function(request, sender, sendResponse){
	if(typeof request.snippetList !== "undefined")
		addCtxSnippetList(Folder.fromArray(request.snippetList));
	else if(request.openBlockSiteModalInParent === true){
		chrome.tabs.query({active: true, currentWindow: true}, function(tabs){
			var tab = tabs[0];
			
			chrome.tabs.sendMessage(tab.id, {showBlockSiteModal: true, data: request.data});
		});
	}
	else if(typeof request.ctxTimestamp !== "undefined")
		latestCtxTimestamp = request.ctxTimestamp;
	else if(request === "givePasteData")
		sendResponse(getPasteData());
});

// open a new tab whenever popup icon is clicked
chrome.browserAction.onClicked.addListener(openSnippetsPage);