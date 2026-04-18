exports.handler = async (event) => {
  return {
    statusCode: 200,
    body: JSON.stringify({
      message: "Netlify Functions 動作確認OK",
      time: new Date().toISOString()
    })
  };
};
