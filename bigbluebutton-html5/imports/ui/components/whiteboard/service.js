import Auth from '/imports/ui/services/auth';
import WhiteboardMultiUser from '/imports/api/whiteboard-multi-user';
import { Slides } from '/imports/api/slides';
import { makeCall } from '/imports/ui/services/api';
import PresentationService from '/imports/ui/components/presentation/service';
import PollService from '/imports/ui/components/poll/service';
import { defineMessages } from 'react-intl';
import { notify } from '/imports/ui/services/notification';
import caseInsensitiveReducer from '/imports/utils/caseInsensitiveReducer';
import { getTextSize } from './utils';

const Annotations = new Mongo.Collection(null);

const intlMessages = defineMessages({
  notifyNotAllowedChange: {
    id: 'app.whiteboard.annotations.notAllowed',
    description: 'Label shown in toast when the user make a change on a shape he doesnt have permission',
  },
  shapeNumberExceeded: {
    id: 'app.whiteboard.annotations.numberExceeded',
    description: 'Label shown in toast when the user tries to add more shapes than the limit',
  },
});

const annotationsQueue = [];
// How many packets we need to have to use annotationsBufferTimeMax
const annotationsMaxDelayQueueSize = 60;
// Minimum bufferTime
const annotationsBufferTimeMin = 30;
// Maximum bufferTime
const annotationsBufferTimeMax = 200;
// Time before running 'sendBulkAnnotations' again if user is offline
const annotationsRetryDelay = 1000;

let annotationsSenderIsRunning = false;

const proccessAnnotationsQueue = async () => {
  annotationsSenderIsRunning = true;
  const queueSize = annotationsQueue.length;

  if (!queueSize) {
    annotationsSenderIsRunning = false;
    return;
  }

  const annotations = annotationsQueue.splice(0, queueSize);

  const isAnnotationSent = await makeCall('sendBulkAnnotations', annotations);

  if (!isAnnotationSent) {
    // undo splice
    annotationsQueue.splice(0, 0, ...annotations);
    setTimeout(proccessAnnotationsQueue, annotationsRetryDelay);
  } else {
    // ask tiago
    const delayPerc = Math.min(
      annotationsMaxDelayQueueSize, queueSize,
    ) / annotationsMaxDelayQueueSize;
    const delayDelta = annotationsBufferTimeMax - annotationsBufferTimeMin;
    const delayTime = annotationsBufferTimeMin + delayDelta * delayPerc;
    setTimeout(proccessAnnotationsQueue, delayTime);
  }
};

const sendAnnotation = (annotation) => {
  // Prevent sending annotations while disconnected
  // TODO: Change this to add the annotation, but delay the send until we're
  // reconnected. With this it will miss things
  if (!Meteor.status().connected) return;

  const index = annotationsQueue.findIndex((ann) => ann.id === annotation.id);
  if (index !== -1) {
    annotationsQueue[index] = annotation;
  } else {
    annotationsQueue.push(annotation);
  }
  if (!annotationsSenderIsRunning) setTimeout(proccessAnnotationsQueue, annotationsBufferTimeMin);
};

const getMultiUser = (whiteboardId) => {
  const data = WhiteboardMultiUser.findOne(
    {
      meetingId: Auth.meetingID,
      whiteboardId,
    },
    { fields: { multiUser: 1 } },
  );

  if (!data || !data.multiUser || !Array.isArray(data.multiUser)) return [];

  return data.multiUser;
};

const getCurrentWhiteboardId = () => {
  const podId = 'DEFAULT_PRESENTATION_POD';
  const currentPresentation = PresentationService.getCurrentPresentation(podId);

  if (!currentPresentation) return null;

  const currentSlide = Slides.findOne(
    {
      podId,
      presentationId: currentPresentation.id,
      current: true,
    },
    { fields: { id: 1 } },
  );

  return currentSlide && currentSlide.id;
};

const hasAnnotations = (presentationId) => {
  const ann = Annotations.findOne(
    { whiteboardId: { $regex: `^${presentationId}` } },
  );
  return ann !== undefined;
};

const isMultiUserActive = (whiteboardId) => {
  const multiUser = getMultiUser(whiteboardId);

  return multiUser.length !== 0;
};

const hasMultiUserAccess = (whiteboardId, userId) => {
  const multiUser = getMultiUser(whiteboardId);

  return multiUser.includes(userId);
};

const addGlobalAccess = (whiteboardId) => {
  makeCall('addGlobalAccess', whiteboardId);
};

const addIndividualAccess = (whiteboardId, userId) => {
  makeCall('addIndividualAccess', whiteboardId, userId);
};

const removeGlobalAccess = (whiteboardId) => {
  makeCall('removeGlobalAccess', whiteboardId);
};

const removeIndividualAccess = (whiteboardId, userId) => {
  makeCall('removeIndividualAccess', whiteboardId, userId);
};

const changeWhiteboardAccess = (userId, access) => {
  const whiteboardId = getCurrentWhiteboardId();

  if (!whiteboardId) return;

  if (access) {
    addIndividualAccess(whiteboardId, userId);
  } else {
    removeIndividualAccess(whiteboardId, userId);
  }
};

const persistShape = (shape, whiteboardId, isModerator) => {
  const annotation = {
    id: shape.id,
    annotationInfo: { ...shape, isModerator },
    wbId: whiteboardId,
    userId: Auth.userID,
  };

  sendAnnotation(annotation);
};

const removeShapes = (shapes, whiteboardId) => makeCall('deleteAnnotations', shapes, whiteboardId);

const changeCurrentSlide = (s) => {
  makeCall('changeCurrentSlide', s);
};

const getShapes = (whiteboardId, curPageId, intl, isLocked) => {
  const unlockedSelector = { whiteboardId };
  const lockedSelector = {
    whiteboardId,
    $or: [
      { 'annotationInfo.isModerator': true },
      { 'annotationInfo.userId': Auth.userID },
    ],
  };

  const annotations = Annotations.find(
    isLocked ? lockedSelector : unlockedSelector,
    {
      fields: { annotationInfo: 1, userId: 1 },
    },
  ).fetch();

  const result = {};

  annotations.forEach((annotation) => {
    if (annotation.annotationInfo.questionType) {
      const modAnnotation = annotation;
      // poll result, convert it to text and create tldraw shape
      modAnnotation.annotationInfo.answers = annotation.annotationInfo.answers.reduce(
        caseInsensitiveReducer, [],
      );
      let pollResult = PollService.getPollResultString(annotation.annotationInfo, intl)
        .split('<br/>').join('\n').replace(/(<([^>]+)>)/ig, '');

      const lines = pollResult.split('\n');
      const longestLine = lines.reduce((a, b) => a.length > b.length ? a : b, '').length;

      // add empty spaces before first | in each of the lines to make them all the same length
      pollResult = lines.map((line) => {
        if (!line.includes('|') || line.length === longestLine) return line;

        const splitLine = line.split(' |');
        const spaces = ' '.repeat(longestLine - line.length);
        return `${splitLine[0]} ${spaces}|${splitLine[1]}`;
      }).join('\n');

      const style = {
        color: 'white',
        dash: 'solid',
        font: 'mono',
        isFilled: true,
        size: 'small',
        scale: 1,
      };

      const textSize = getTextSize(pollResult, style, padding = 20);

      modAnnotation.annotationInfo = {
        childIndex: 0,
        id: annotation.annotationInfo.id,
        name: `poll-result-${annotation.annotationInfo.id}`,
        type: 'rectangle',
        label: pollResult,
        labelPoint: [0.5, 0.5],
        parentId: `${curPageId}`,
        point: [0, 0],
        size: textSize,
        style,
      };
      modAnnotation.annotationInfo.questionType = false;
    }
    result[annotation.annotationInfo.id] = annotation.annotationInfo;
  });
  return result;
};

const getCurrentPres = () => {
  const podId = 'DEFAULT_PRESENTATION_POD';
  return PresentationService.getCurrentPresentation(podId);
};

const initDefaultPages = (count = 1) => {
  const pages = {};
  const pageStates = {};
  let i = 0;
  while (i < count + 1) {
    pages[`${i}`] = {
      id: `${i}`,
      name: `Slide ${i}`,
      shapes: {},
      bindings: {},
    };
    pageStates[`${i}`] = {
      id: `${i}`,
      selectedIds: [],
      camera: {
        point: [0, 0],
        zoom: 1,
      },
    };
    i += 1;
  }
  return { pages, pageStates };
};

const notifyNotAllowedChange = (intl) => {
  if (intl) notify(intl.formatMessage(intlMessages.notifyNotAllowedChange), 'warning', 'whiteboard');
};

const notifyShapeNumberExceeded = (intl, limit) => {
  if (intl) notify(intl.formatMessage(intlMessages.shapeNumberExceeded, { 0: limit }), 'warning', 'whiteboard');
};

const toggleToolsAnimations = (activeAnim, anim, time) => {
  const tdTools = document.querySelector('#TD-Tools');
  const topToolbar = document.getElementById('TD-Styles')?.parentElement;
  const optionsDropdown = document.getElementById('WhiteboardOptionButton');
  if (tdTools && topToolbar) {
    tdTools.classList.remove(activeAnim);
    topToolbar.classList.remove(activeAnim);
    topToolbar.style.transition = `opacity ${time} ease-in-out`;
    tdTools.style.transition = `opacity ${time} ease-in-out`;
    tdTools?.classList?.add(anim);
    topToolbar?.classList?.add(anim);
  }
  if (optionsDropdown) {
    optionsDropdown.classList.remove(activeAnim);
    optionsDropdown.style.transition = `opacity ${time} ease-in-out`;
    optionsDropdown?.classList?.add(anim);
  }
}

const formatAnnotations = (annotations, intl, curPageId) => {
  const result = {};
  annotations.forEach((annotation) => {
    let annotationInfo = JSON.parse(annotation.annotationInfo);

    if (annotationInfo.questionType) {
      // poll result, convert it to text and create tldraw shape
      annotationInfo.answers = annotationInfo.answers.reduce(
        caseInsensitiveReducer, [],
      );
      let pollResult = PollService.getPollResultString(annotationInfo, intl)
        .split('<br/>').join('\n').replace(/(<([^>]+)>)/ig, '');

      const lines = pollResult.split('\n');
      const longestLine = lines.reduce((a, b) => a.length > b.length ? a : b, '').length;

      // add empty spaces before first | in each of the lines to make them all the same length
      pollResult = lines.map((line) => {
        if (!line.includes('|') || line.length === longestLine) return line;

        const splitLine = line.split(' |');
        const spaces = ' '.repeat(longestLine - line.length);
        return `${splitLine[0]} ${spaces}|${splitLine[1]}`;
      }).join('\n');

      const style = {
        color: 'white',
        dash: 'solid',
        font: 'mono',
        isFilled: true,
        size: 'small',
        scale: 1,
      };

      const padding = 20;
      const textSize = getTextSize(pollResult, style, padding);

      annotationInfo = {
        childIndex: 0,
        id: annotationInfo.id,
        name: `poll-result-${annotationInfo.id}`,
        type: 'rectangle',
        label: pollResult,
        labelPoint: [0.5, 0.5],
        parentId: `${curPageId}`,
        point: [0, 0],
        size: textSize,
        style,
      };
      annotationInfo.questionType = false;
    }
    result[annotationInfo.id] = annotationInfo;
  });
  return result;
};

export {
  initDefaultPages,
  Annotations,
  sendAnnotation,
  getMultiUser,
  getCurrentWhiteboardId,
  isMultiUserActive,
  hasMultiUserAccess,
  changeWhiteboardAccess,
  addGlobalAccess,
  addIndividualAccess,
  removeGlobalAccess,
  removeIndividualAccess,
  persistShape,
  getShapes,
  getCurrentPres,
  removeShapes,
  changeCurrentSlide,
  notifyNotAllowedChange,
  notifyShapeNumberExceeded,
  hasAnnotations,
  toggleToolsAnimations,
  formatAnnotations,
};
